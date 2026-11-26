/**
 * Isolated single-cell managed-review runner.
 *
 * Launched inside an OS isolation boundary by isolated-review-controller.mjs.
 * Receives ONLY one pinned candidate snapshot and minimum review settings via
 * `--job <job.json>`. Never reads cohort files, settled baseline findings,
 * judge inputs/outputs, or raw holdout logs, and always enforces Default Access.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewedMergeBase } from "./review-range.mjs";
import { initReviewWorkspace } from "./review-workspace.mjs";
import { buildPendingRequestResponse } from "@pwragent/shared/pending-request-response";
import type {
  AgentEvent,
  StartReviewRequest,
  StartReviewResponse,
} from "@pwragent/shared/contracts/agent";
import type {
  AppServerBackendKind,
  AppServerPendingRequestNotification,
  AppServerReviewOutput,
} from "@pwragent/shared/contracts/normalized-app-server";
import { initializeMainLogger } from "@pwragent/desktop-main/log";
import {
  ensureNamedProfileExists,
  resolveActiveProfileDir,
  resolveActiveProfileName,
} from "@pwragent/desktop-main/profile";
import { getDesktopOverlayStore } from "@pwragent/desktop-main/storage/desktop-overlay-store";
import {
  disposeAppState,
  isAppStateInitialized,
} from "@pwragent/desktop-main/storage/desktop-state-lifecycle";
import { issueProviderDiscoveryPermit } from "@pwragent/desktop-main/settings/provider-discovery-permit";
import { createOutpostRuntimePolicy, type OwnerRuntimePolicy } from "@pwragent/desktop-main/owner-runtime-policy";
import { createHeadlessOwnerHostServices } from "@pwragent/desktop-main/headless/owner-host-services";
import {
  disposeOwnerServices,
  disposeOwnerServicesSync,
  prepareOwnerShutdown,
  startOwnerServices,
} from "@pwragent/desktop-main/owner-services";

type ManagedArmId = "codex" | "neon";
const ARM_BACKEND: Readonly<Record<ManagedArmId, AppServerBackendKind>> = {
  codex: "codex",
  neon: "acp:antigravity",
};

type RunnerSnapshot = {
  prNumber: number;
  prUrl: string;
  prTitle?: string;
  baseBranch: string;
  headBranch: string;
  baseCommit: string;
  headCommit: string;
  mergeBaseCommit: string;
};

type RunnerJob = {
  schemaVersion: 1;
  cellToken: string;
  arm: ManagedArmId;
  model?: string;
  explicitNeonModel?: boolean;
  reasoningEffort?: string;
  timeoutMs: number;
  workspacePath: string;
  outputPath: string;
  pwragentHome: string;
  runtimeRoot: string;
  pinnedPatchFile?: string;
  codexProtectedRoots?: string[];
  codexReadOnlyRoots?: string[];
  snapshot: RunnerSnapshot;
};

type Outcome = { status: "completed" | "failed" | "cancelled" | "timeout"; error?: string };

const ALLOWED_JOB_KEYS = new Set([
  "schemaVersion",
  "cellToken",
  "arm",
  "model",
  "explicitNeonModel",
  "reasoningEffort",
  "timeoutMs",
  "workspacePath",
  "outputPath",
  "pwragentHome",
  "runtimeRoot",
  "pinnedPatchFile",
  "codexProtectedRoots",
  "codexReadOnlyRoots",
  "snapshot",
]);

const ALLOWED_SNAPSHOT_KEYS = new Set([
  "prNumber",
  "prUrl",
  "prTitle",
  "baseBranch",
  "headBranch",
  "baseCommit",
  "headCommit",
  "mergeBaseCommit",
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const PR_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)$/;

const deadlineExceeded = Symbol("deadline exceeded");
const approvalMethods = new Set([
  "turn/requestApproval",
  "review/requestApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

async function beforeDeadline<T>(operation: Promise<T>, timeout: number): Promise<T | typeof deadlineExceeded> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<typeof deadlineExceeded>((resolve) => {
        timer = setTimeout(() => resolve(deadlineExceeded), Math.max(0, timeout));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function writeAtomicJson(file: string, record: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function parseJobArg(argv: readonly string[]): string {
  for (const forbidden of ["--cohort", "--repo", "--allow-full-access"]) {
    if (argv.includes(forbidden)) {
      throw new Error(`Isolated reviewer runner does not accept ${forbidden}.`);
    }
  }
  const idx = argv.indexOf("--job");
  if (idx < 0 || idx + 1 >= argv.length || !argv[idx + 1] || argv[idx + 1]!.startsWith("--")) {
    throw new Error("Usage: isolated-review-runner.js --job <job.json>");
  }
  return path.resolve(argv[idx + 1]!);
}

function assertOnlyAllowedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unexpected field "${key}" in isolated runner ${label}.`);
    }
  }
}

function validateJob(raw: unknown): RunnerJob {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Runner job manifest must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  assertOnlyAllowedKeys(obj, ALLOWED_JOB_KEYS, "job");
  if (obj.schemaVersion !== 1) throw new Error("Unsupported runner job schemaVersion.");
  if (typeof obj.cellToken !== "string" || !TOKEN_PATTERN.test(obj.cellToken)) {
    throw new Error("Runner job requires a valid opaque cellToken.");
  }
  if (obj.arm !== "codex" && obj.arm !== "neon") {
    throw new Error("Isolated reviewer runner supports only managed arms: codex or neon.");
  }
  if (!Number.isSafeInteger(obj.timeoutMs) || (obj.timeoutMs as number) <= 0 || (obj.timeoutMs as number) > 2_147_483_647) {
    throw new Error("Runner job timeoutMs must be a positive integer within supported bounds.");
  }
  for (const field of ["workspacePath", "outputPath", "pwragentHome", "runtimeRoot"] as const) {
    if (typeof obj[field] !== "string" || !path.isAbsolute(obj[field] as string)) {
      throw new Error(`Runner job ${field} must be an absolute path.`);
    }
  }
  if (obj.pinnedPatchFile !== undefined) {
    if (typeof obj.pinnedPatchFile !== "string" || !obj.pinnedPatchFile
      || path.isAbsolute(obj.pinnedPatchFile) || obj.pinnedPatchFile.includes("/") || obj.pinnedPatchFile.includes("\\")) {
      throw new Error("Runner job pinnedPatchFile must be a simple filename inside the workspace.");
    }
  }
  if (obj.codexProtectedRoots !== undefined && (!Array.isArray(obj.codexProtectedRoots)
    || obj.codexProtectedRoots.some((item) => typeof item !== "string" || !path.isAbsolute(item)))) {
    throw new Error("Runner job codexProtectedRoots must be absolute paths.");
  }
  if (obj.codexReadOnlyRoots !== undefined && (!Array.isArray(obj.codexReadOnlyRoots)
    || obj.codexReadOnlyRoots.some((item) => typeof item !== "string" || !path.isAbsolute(item)))) {
    throw new Error("Runner job codexReadOnlyRoots must be absolute paths.");
  }
  if (!obj.snapshot || typeof obj.snapshot !== "object" || Array.isArray(obj.snapshot)) {
    throw new Error("Runner job requires a pinned snapshot.");
  }
  const snap = obj.snapshot as Record<string, unknown>;
  assertOnlyAllowedKeys(snap, ALLOWED_SNAPSHOT_KEYS, "snapshot");
  if (!Number.isSafeInteger(snap.prNumber) || (snap.prNumber as number) <= 0) {
    throw new Error("Snapshot prNumber must be a positive integer.");
  }
  if (typeof snap.prUrl !== "string" || !PR_URL_PATTERN.test(snap.prUrl)) {
    throw new Error("Snapshot prUrl must be a canonical GitHub pull request URL.");
  }
  for (const shaField of ["baseCommit", "headCommit", "mergeBaseCommit"] as const) {
    if (typeof snap[shaField] !== "string" || !SHA_PATTERN.test(snap[shaField] as string)) {
      throw new Error(`Snapshot ${shaField} must be a 40-character Git commit SHA.`);
    }
  }
  if (typeof snap.baseBranch !== "string" || !snap.baseBranch.trim()
    || typeof snap.headBranch !== "string" || !snap.headBranch.trim()) {
    throw new Error("Snapshot requires baseBranch and headBranch.");
  }
  return raw as RunnerJob;
}

function readLedgerStatsFromLog(
  logPath: string,
  turnId: string,
): { total: number; keep: number; drop: number; pending: number } | null {
  try {
    const text = fs.readFileSync(logPath, "utf8");
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (!line.includes("managed review artifact published") || !line.includes(turnId)) {
        continue;
      }
      const mTotal = line.match(/candidateLedgerTotal[=:"\s]+(\d+)/);
      const mKeep = line.match(/candidateLedgerKeep[=:"\s]+(\d+)/);
      const mDrop = line.match(/candidateLedgerDrop[=:"\s]+(\d+)/);
      const mPend = line.match(/candidateLedgerPending[=:"\s]+(\d+)/);
      if (mTotal) {
        return {
          total: Number(mTotal[1]),
          keep: Number(mKeep?.[1] ?? 0),
          drop: Number(mDrop?.[1] ?? 0),
          pending: Number(mPend?.[1] ?? 0),
        };
      }
      return { total: 0, keep: 0, drop: 0, pending: 0 };
    }
  } catch {
    // ignore missing/unreadable log
  }
  return null;
}

async function main(): Promise<void> {
  const jobPath = parseJobArg(process.argv.slice(2));
  const job = validateJob(JSON.parse(fs.readFileSync(jobPath, "utf8")));
  const { snapshot, arm } = job;
  const backend: AppServerBackendKind = ARM_BACKEND[arm];
  const urlMatch = PR_URL_PATTERN.exec(snapshot.prUrl)!;
  const [, prOrg, prRepo] = urlMatch;

  // Verify the staged snapshot matches the pinned merge-base before starting.
  const observedMergeBase = reviewedMergeBase(job.workspacePath, snapshot.baseCommit, snapshot.headCommit);
  if (observedMergeBase !== snapshot.mergeBaseCommit) {
    throw new Error("Staged review workspace does not match the pinned merge-base commit.");
  }
  if (arm === "neon") {
    if (!job.pinnedPatchFile || !fs.existsSync(path.join(job.workspacePath, job.pinnedPatchFile))) {
      throw new Error("Isolated Neon Default Access review requires a staged pinned patch file.");
    }
  }

  // Enforce clean isolated Git and PwrAgent process env inside the runner.
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = os.devNull;
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.GIT_ALLOW_PROTOCOL = "";
  process.env.PWRAGENT_HOME = job.pwragentHome;
  process.env.PWRAGENT_PROFILE = "eval";
  process.env.PWRAGENT_DISABLE_MESSAGING = "1";

  fs.mkdirSync(job.pwragentHome, { recursive: true, mode: 0o700 });
  const resourcesDir = path.join(job.runtimeRoot, "resources");
  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true, mode: 0o700 });
  }

  const profile = ensureNamedProfileExists("eval", { env: process.env });
  const configPath = path.join(profile.profileDir, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      "[general]",
      "notifications_enabled = false",
      "",
      "[federation]",
      'mode = "off"',
      "",
      "[experimental]",
      "full_access_risk_warning_dismissed = false",
      "token_miser_enabled = false",
      "",
      "[acp_agents.antigravity]",
      `enabled = ${arm === "neon"}`,
      "",
      "[acp_agents.gemini]",
      "enabled = false",
      "",
      "[acp_agents.grok]",
      "enabled = false",
      "",
      "[acp_agents.kimi]",
      "enabled = false",
      "",
      "[acp_agents.qwen]",
      "enabled = false",
      "",
    ].join("\n"),
    "utf8",
  );

  const profileDirectory = resolveActiveProfileDir();
  const logDirectory = path.join(profileDirectory, "logs");
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const mainLogPath = path.join(
    logDirectory,
    `profile-${resolveActiveProfileName()}.main.log`,
  );

  initializeMainLogger({
    profileName: resolveActiveProfileName(),
    logDirectory,
    appName: "PwrAgent Isolated Eval",
    consoleEnabled: false,
  });

  const basePolicy = createOutpostRuntimePolicy();
  const mergedProtectedRoots = [
    ...new Set([
      ...(basePolicy.codexProtectedRoots ?? []),
      ...(job.codexProtectedRoots ?? []),
    ]),
  ];
  const mergedReadOnlyRoots = [
    ...new Set([
      ...(basePolicy.codexReadOnlyRoots ?? []),
      ...(job.codexReadOnlyRoots ?? []),
    ]),
  ];

  const runtimePolicy: OwnerRuntimePolicy = {
    ...basePolicy,
    enabledBackends: [backend],
    codexOpenAiProviderEnabled: true,
    approvals: "ask",
    agentNetwork: false,
    // Keep "full" memberRole so the 4 in-memory managed review ledger tools
    // stay enabled while federation is off and no other tools are attached to
    // managedReview child sessions.
    memberRole: "full",
    executionModes: ["default"],
    sandboxByMode: { default: "read-only" },
    codexProtectedRoots: mergedProtectedRoots,
    codexReadOnlyRoots: mergedReadOnlyRoots,
  };

  const host = createHeadlessOwnerHostServices({
    runtime: {
      version: "1.5.0-isolated-eval",
      isPackaged: false,
      appRoot: job.runtimeRoot,
      resourcesPath: path.join(job.runtimeRoot, "resources"),
    },
    profileDirectory,
    runtimePolicy,
    onQuit: () => {},
  });

  const services = await startOwnerServices(host, {
    bootMode: "active-profile",
    startedAt: Date.now(),
  });
  services.prewarm(issueProviderDiscoveryPermit("startup"));

  const registry = services.registry;
  let unsubscribe: (() => void) | undefined;

  try {
    const modelOverride = job.model ?? (arm === "codex" ? "gpt-6.2-sol" : "gemini-4-neon");
    const explicitNeonModel = Boolean(job.explicitNeonModel);
    let backendsList: Awaited<ReturnType<typeof registry.listBackends>>["backends"] = [];
    const getModels = (entry: (typeof backendsList)[number] | undefined) =>
      entry?.launchpadOptions?.models?.length
        ? entry.launchpadOptions.models
        : (entry?.acp?.runtime?.models?.availableModels ?? []);
    const selectNeonModel = (entry: (typeof backendsList)[number] | undefined) => {
      const models = getModels(entry);
      return models.find((model) => model.id === modelOverride)?.id
        ?? (explicitNeonModel ? undefined : models.find((model) => /neon/i.test(model.id))?.id);
    };

    const waitStart = Date.now();
    let refreshedAgy = false;
    for (;;) {
      const res = await registry.listBackends({ includeUnavailable: true });
      backendsList = res.backends;
      const entry = backendsList.find((b) => b.kind === backend);
      if (arm === "neon" && !refreshedAgy && entry?.available && getModels(entry).length === 0) {
        refreshedAgy = true;
        try {
          const warmupParent = path.join(job.pwragentHome, "warmup");
          fs.mkdirSync(warmupParent, { recursive: true, mode: 0o700 });
          const warmupCwd = await initReviewWorkspace(warmupParent, "catalog", undefined);
          await registry.startThread({
            backend: "acp:antigravity",
            cwd: warmupCwd,
            executionMode: "default",
            mcpProviderServersEnabled: false,
            mcpConnectionIds: [],
          });
        } catch {
          // Wait loop retries backend readiness.
        }
        const refreshed = await registry.listBackends({ includeUnavailable: true });
        backendsList = refreshed.backends;
      }

      const readyEntry = backendsList.find((b) => b.kind === backend);
      if (arm === "codex") {
        if (readyEntry?.available && getModels(readyEntry).some((m) => m.id === modelOverride)) {
          break;
        }
      } else {
        const selected = selectNeonModel(readyEntry);
        if (explicitNeonModel && readyEntry?.available && getModels(readyEntry).length && !selected) {
          throw new Error(`Requested Neon model ${modelOverride} is unavailable.`);
        }
        if (readyEntry?.available && selected) break;
      }

      if (Date.now() - waitStart > 90_000) {
        throw new Error(`Timed out waiting for isolated backend ${backend}.`);
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }

    const readyEntry = backendsList.find((b) => b.kind === backend);
    const resolvedModel = arm === "codex"
      ? (getModels(readyEntry).find((m) => m.id === modelOverride)?.id ?? modelOverride)
      : (selectNeonModel(readyEntry) ?? modelOverride);
    const resolvedEffort = arm === "neon" && resolvedModel.endsWith("-high")
      ? undefined
      : job.reasoningEffort;

    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    const remaining = () => job.timeoutMs - elapsed();

    let turnId: string | undefined;
    let reviewThreadId: string | undefined;
    let parentThreadId: string | undefined;
    let reviewOutput: AppServerReviewOutput | undefined;
    let reviewText: string | undefined;
    const approvals = new Set<string>();
    let resolveTerminal!: (result: Outcome) => void;
    let terminalSettled = false;
    const settleTerminal = (result: Outcome) => {
      if (terminalSettled) return;
      terminalSettled = true;
      resolveTerminal(result);
    };
    const terminal = new Promise<Outcome>((resolve) => { resolveTerminal = resolve; });
    let started: StartReviewResponse | undefined;
    let outcome: Outcome;

    const interrupt = (active: StartReviewResponse) =>
      registry.interruptTurn({ backend: active.backend, threadId: active.threadId, turnId: active.turnId });

    const onSignal = (sig: NodeJS.Signals) => {
      if (started) {
        void interrupt(started).catch(() => {});
      }
      settleTerminal({ status: "cancelled", error: `Runner interrupted by ${sig}.` });
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    const matchesSession = (threadId: string, eventTurnId?: string) =>
      (threadId === parentThreadId || threadId === reviewThreadId)
      && (!turnId || !eventTurnId || eventTurnId === turnId);

    async function answerApproval(
      eventBackend: AppServerBackendKind,
      notification: AppServerPendingRequestNotification,
    ): Promise<void> {
      if (!approvalMethods.has(notification.method)) return;
      const { threadId, turnId: reqTurnId, requestId } = notification.params;
      if (typeof threadId !== "string" || typeof requestId !== "string") return;
      if (!matchesSession(threadId, reqTurnId ?? undefined) || approvals.has(requestId)) return;
      approvals.add(requestId);
      try {
        const decision = notification.method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" }
          : buildPendingRequestResponse(notification, "decline");
        await registry.submitServerRequest({
          backend: eventBackend,
          threadId,
          requestId,
          ...(reqTurnId ? { turnId: reqTurnId } : {}),
          response: decision,
        });
      } catch {
        // Ignore approval decline errors on closed sessions.
      }
    }

    unsubscribe = registry.onEvent((event: AgentEvent) => {
      if (event.backend !== backend) return;
      const { method } = event.notification;
      const params = event.notification.params as Record<string, unknown>;
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (!threadId) return;
      if (approvalMethods.has(method)) {
        void answerApproval(event.backend, event.notification as AppServerPendingRequestNotification);
        return;
      }
      if (threadId !== parentThreadId) return;
      const turn = params.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
      const eventTurnId = typeof params.turnId === "string" ? params.turnId : turn?.id;
      if (!eventTurnId || (turnId && eventTurnId !== turnId)) return;
      if (method === "item/completed") {
        const item = params.item as Record<string, unknown> | undefined;
        if (item?.type !== "exitedReviewMode") return;
        const data = item.data as Record<string, unknown> | undefined;
        if (data?.reviewOutput) reviewOutput = data.reviewOutput as AppServerReviewOutput;
        if (typeof item.review === "string") reviewText = item.review;
      } else if (method === "turn/failed" || (method === "turn/completed" && turn?.status === "failed")) {
        settleTerminal({ status: "failed", error: turn?.error?.message ?? "turn failed" });
      } else if (method === "turn/cancelled" || (method === "turn/completed"
        && (turn?.status === "cancelled" || turn?.status === "interrupted"))) {
        settleTerminal({ status: "cancelled" });
      } else if (method === "turn/completed") {
        settleTerminal({ status: "completed" });
      }
    });

    const timedOut = (stage: string): Outcome => ({
      status: "timeout",
      error: `Timed out during ${stage} after ${job.timeoutMs}ms`,
    });

    try {
      const setup = await beforeDeadline((async () => {
        const parent = await registry.startThread({
          backend,
          cwd: job.workspacePath,
          executionMode: "default",
          ...(resolvedModel ? { model: resolvedModel } : {}),
          mcpProviderServersEnabled: false,
          mcpConnectionIds: [],
          ...(resolvedEffort ? { reasoningEffort: resolvedEffort } : {}),
        });
        await getDesktopOverlayStore().setThreadPullRequests({
          backend,
          threadId: parent.threadId,
          prs: [
            {
              provider: "github",
              repo: `${prOrg}/${prRepo}`,
              number: snapshot.prNumber,
              url: snapshot.prUrl,
              title: snapshot.prTitle ?? `PR #${snapshot.prNumber}`,
              state: "open",
              baseRefName: snapshot.baseBranch,
              headRefName: snapshot.headBranch,
              baseSha: snapshot.baseCommit,
              headSha: snapshot.headCommit,
              source: "branch",
              linkedDirectoryPaths: [job.workspacePath],
            } as never,
          ],
          fetchedAt: Date.now(),
        });
        return parent;
      })(), remaining());

      if (setup === deadlineExceeded) {
        outcome = timedOut("cell setup");
      } else {
        parentThreadId = setup.threadId;
        const antigravityAccess = arm === "neon"
          ? {
              mode: "plan" as const,
              fullAccess: false,
              pinnedPatchFile: job.pinnedPatchFile,
            }
          : undefined;

        const request: StartReviewRequest = {
          backend,
          reviewBackend: backend,
          threadId: parentThreadId,
          runMode: "pwragent-sub-agent",
          cwd: job.workspacePath,
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(resolvedEffort ? { reasoningEffort: resolvedEffort } : {}),
          target: {
            type: "pullRequest",
            url: snapshot.prUrl,
            snapshot: {
              pullRequest: {
                provider: "github.com",
                org: prOrg!,
                repo: prRepo!,
                number: snapshot.prNumber,
                url: snapshot.prUrl,
                ...(snapshot.prTitle ? { title: snapshot.prTitle } : {}),
                baseRefName: snapshot.baseBranch,
                headRefName: snapshot.headBranch,
              },
              baseCommit: snapshot.baseCommit,
              headCommit: snapshot.headCommit,
              mergeBaseCommit: snapshot.mergeBaseCommit,
              capturedAt: Date.now(),
            },
          },
        };

        const starting = registry.startReview(request, true, undefined, antigravityAccess);
        const accepted = await beforeDeadline(starting, remaining());
        if (accepted === deadlineExceeded) {
          outcome = timedOut("review start");
          void starting.then(interrupt).catch(() => {});
        } else {
          started = accepted;
          turnId = started.turnId;
          reviewThreadId = started.reviewThreadId;
          for (const pending of registry.listPendingServerRequests()) {
            void answerApproval(pending.backend, pending.notification);
          }
          const result = await beforeDeadline(terminal, remaining());
          if (result === deadlineExceeded) {
            outcome = timedOut("review");
            void interrupt(started).catch(() => {});
            await beforeDeadline(terminal, 10_000);
          } else {
            outcome = result;
            if (outcome.status === "completed" && !Array.isArray(reviewOutput?.findings)) {
              outcome = { status: "failed", error: "Review completed without structured findings." };
            }
          }
        }
      }
    } catch (error) {
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    } finally {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }

    const findings = reviewOutput?.findings ?? [];
    const ledger = started ? readLedgerStatsFromLog(mainLogPath, started.turnId) : null;
    const record = {
      cellToken: job.cellToken,
      arm,
      backend,
      model: resolvedModel,
      baseCommit: snapshot.baseCommit,
      headCommit: snapshot.headCommit,
      mergeBaseCommit: snapshot.mergeBaseCommit,
      workspacePath: job.workspacePath,
      reasoningEffort: resolvedEffort ?? null,
      executionMode: "default" as const,
      status: outcome.status,
      error: outcome.error ?? null,
      elapsedSec: Math.round(elapsed() / 1000),
      approvals: approvals.size,
      parentThreadId,
      reviewThreadId: started?.reviewThreadId,
      turnId: started?.turnId,
      structured: Array.isArray(reviewOutput?.findings),
      findingsCount: findings.length,
      overallCorrectness: reviewOutput?.overall_correctness ?? null,
      overallConfidence: reviewOutput?.overall_confidence_score ?? null,
      overallExplanation: reviewOutput?.overall_explanation ?? null,
      findings,
      reviewText: reviewText ?? null,
      ledger,
      completedAt: new Date().toISOString(),
    };
    writeAtomicJson(job.outputPath, record);
  } finally {
    unsubscribe?.();
    prepareOwnerShutdown();
    try {
      if (await beforeDeadline(disposeOwnerServices("isolated-eval-complete"), 10_000) === deadlineExceeded) {
        throw new Error("Headless owner shutdown did not complete.");
      }
    } finally {
      if (isAppStateInitialized()) {
        disposeOwnerServicesSync();
        disposeAppState();
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[isolated-runner] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
