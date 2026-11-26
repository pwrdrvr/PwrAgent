/**
 * Headless PwrAgent owner eval driver for managed and native code reviews.
 *
 * Boots startOwnerServices in pure Node in an isolated PWRAGENT_HOME, stages
 * pinned PR snapshot workspaces safely outside `~/.codex` and `PWRAGENT_HOME`,
 * executes reviews across a cohort JSON (`codex`, `codex-native`, `neon`,
 * `claude-native`), and records findings, ledger stats, approval telemetry,
 * and observed token/replay/list-cost metrics from PwrAgent's owner API.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isNativeClaudeSourceKey, nativeClaudeReviewCommand } from "./native-claude-capture.mjs";
import { reviewedMergeBase } from "./review-range.mjs";
import { checkoutReviewSnapshot, initReviewWorkspace, writePinnedReviewPatch } from "./review-workspace.mjs";
import {
  extractReviewFromExitedItem,
  isReviewTerminalEventMatch,
} from "./review-event-normalizer";
import { resolveSafeWorkspaceParent } from "../../shared/workspace-staging.mjs";
import { readCellUsageFromRegistry, type CellUsageMetrics } from "../../shared/usage-metrics";
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
  ThreadExecutionMode,
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

type CohortCase = {
  id: string;
  pr: number;
  backend: string;
  bucket: string;
  baseline: {
    prNumber?: number | null;
    prUrl?: string | null;
    prTitle?: string | null;
    branch?: string | null;
    baseBranch?: string;
    baseCommit: string;
    headCommit: string;
  };
};

type CohortFile =
  | CohortCase[]
  | {
      name?: string;
      split?: string;
      blind?: boolean;
      cases: CohortCase[];
    };

type ArmId = "codex" | "codex-native" | "neon" | "claude-native";
const armBackend: Readonly<Record<ArmId, AppServerBackendKind>> = {
  codex: "codex",
  "codex-native": "codex",
  neon: "acp:antigravity",
  "claude-native": "claude",
};
const isCodexArm = (arm: ArmId) => arm === "codex" || arm === "codex-native";

type ApprovalTelemetry = {
  requestId: string;
  method: string;
  decision: string;
  command?: string;
};

type Outcome = { status: "completed" | "failed" | "cancelled" | "timeout"; error?: string };
const deadlineExceeded = Symbol("deadline exceeded");
const approvalMethods = new Set([
  "turn/requestApproval", "review/requestApproval", "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval", "item/permissions/requestApproval", "applyPatchApproval", "execCommandApproval",
]);
const runFile = promisify(execFile);

async function beforeDeadline<T>(operation: Promise<T>, timeout: number): Promise<T | typeof deadlineExceeded> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<typeof deadlineExceeded>((resolve) => {
      timer = setTimeout(() => resolve(deadlineExceeded), Math.max(0, timeout));
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function writeCell(file: string, record: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2));
  fs.renameSync(temporary, file);
}

function extractApprovalCommand(params: Record<string, unknown>): string | undefined {
  for (const key of ["command", "cmd", "title", "reason"]) {
    const val = params[key];
    if (typeof val === "string" && val.trim()) return val.trim().slice(0, 200);
    if (Array.isArray(val) && val.every((item) => typeof item === "string")) {
      return val.join(" ").trim().slice(0, 200);
    }
  }
  return undefined;
}

let blindOutput = false;

function parseArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1]!;
  }
  return fallback;
}

function hasCommit(repoCwd: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", repoCwd, "cat-file", "-e", `${sha}^{commit}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureCommitPresent(
  repoCwd: string,
  remote: string,
  prNumber: number,
  sha: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected a pinned commit SHA.");
  if (hasCommit(repoCwd, sha)) return;
  try {
    await runFile(
      "git",
      ["-C", repoCwd, "fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/pull/${prNumber}/head`],
      { timeout: 60_000, env, signal },
    );
  } catch {
    signal.throwIfAborted();
  }
  if (!hasCommit(repoCwd, sha)) {
    await runFile(
      "git",
      ["-C", repoCwd, "fetch", "--no-tags", "--no-write-fetch-head", remote, sha],
      { timeout: 60_000, env, signal },
    );
  }
  if (!hasCommit(repoCwd, sha)) {
    throw new Error(`Commit ${sha} for PR #${prNumber} could not be fetched from ${remote}`);
  }
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
    // ignore
  }
  return null;
}

async function main() {
  const repoCwd = path.resolve(parseArg("--repo", process.cwd()));
  const cohortPath = path.resolve(
    parseArg(
      "--cohort",
      path.join(repoCwd, "evals/managed-review/cohorts/dev-1.json"),
    ),
  );
  const outDir = path.resolve(
    parseArg("--out", path.join(repoCwd, "evals/runs/dev-1")),
  );
  const requestedWorkspaceRoot = parseArg("--workspace-root", "") || undefined;
  const keepWorkspaces = process.argv.includes("--keep-workspaces");
  const remote = parseArg("--remote", "origin");
  const casesArg = parseArg("--cases", "all");
  const armsArg = parseArg("--arms", "codex,neon");
  const timeoutMs = Number(parseArg("--timeout-ms", "900000"));
  const caseConcurrency = Number(parseArg("--concurrency", "2"));
  const codexModelOverride = parseArg("--codex-model", "gpt-6.2-sol");
  const codexEffortOverride = parseArg("--codex-effort", "xhigh");
  const neonModelOverride = parseArg("--neon-model", "gemini-4-neon");
  const explicitNeonModel = process.argv.includes("--neon-model");
  const neonEffortOverride = parseArg("--neon-effort", "high");
  const claudeModel = parseArg("--claude-model", "") || undefined;
  const claudeEffort = parseArg("--claude-effort", "high");
  const revLabel = parseArg("--rev-label", "") || undefined;
  const promptSha256 = parseArg("--prompt-sha256", "") || undefined;
  const force = process.argv.includes("--force");

  const allowFullAccess = process.argv.includes("--allow-full-access");
  const executionMode: ThreadExecutionMode = allowFullAccess ? "full-access" : "default";
  const parsedCohort = JSON.parse(fs.readFileSync(cohortPath, "utf8")) as CohortFile;
  const allCases = Array.isArray(parsedCohort) ? parsedCohort : parsedCohort.cases;
  const blind = !Array.isArray(parsedCohort) && parsedCohort.blind === true;
  blindOutput = blind;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(caseConcurrency) || caseConcurrency <= 0) {
    throw new Error("Concurrency and timeout must be positive integers within the supported bounds.");
  }
  const requestedArms = [...new Set(armsArg.split(",").map((arm) => arm.trim()).filter(Boolean))];
  if (!requestedArms.length || !requestedArms.every((arm): arm is ArmId => Object.hasOwn(armBackend, arm))) {
    throw new Error("Arms must be codex, codex-native, neon, or claude-native.");
  }
  const nativeCollection = requestedArms.includes("claude-native");
  if (blind && !(nativeCollection && parsedCohort.split === "collection"
    && allCases.every(({ baseline }) => !Object.hasOwn(baseline, "items")))) {
    process.stderr.write("[eval] Blind evaluation requires a separate reviewer environment (use isolated-controller.mjs or pnpm eval:review). This local driver cannot hide baseline files.\n");
    process.exitCode = 1;
    return;
  }
  if (nativeCollection && (requestedArms.length !== 1 || allowFullAccess)) {
    throw new Error("Native Claude baseline collection runs on its own with Default Access.");
  }
  const selectedCases = casesArg === "all"
    ? allCases
    : allCases.filter((c) => casesArg.split(",").map((id) => id.trim()).includes(c.id));
  if (!selectedCases.length || selectedCases.some((c) => !/^[A-Za-z0-9_-]+$/.test(c.id))
    || new Set(selectedCases.map((c) => c.id)).size !== selectedCases.length) {
    throw new Error("Select at least one case with a unique, valid case ID.");
  }
  const snapshotKeys = selectedCases.map((c) => `${c.baseline.prNumber ?? c.pr}:${c.baseline.headCommit}`);
  if (new Set(snapshotKeys).size !== selectedCases.length) {
    throw new Error("Each PR head must appear in only one matrix case.");
  }
  const bundleSha256 = createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
  const requiredBackends: AppServerBackendKind[] = [...new Set(requestedArms.map((arm) => armBackend[arm]))];
  const totals = { completed: 0, failed: 0, cancelled: 0, timeout: 0, skipped: 0 };
  let stopReason: string | undefined;

  const resultsDir = path.join(outDir, "results");
  const pwragentHome = path.join(outDir, "pwragent-home");
  // Stage workspaces safely outside CODEX_HOME (~/.codex) and PwrAgent profile
  // state so worktrees inside ~/.codex/worktrees/... never trip Outpost's
  // Codex sandbox working-directory guard.
  const workspacesDir = resolveSafeWorkspaceParent({
    requestedParent: requestedWorkspaceRoot,
    env: process.env,
    pwragentHome,
  });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(workspacesDir, { recursive: true });
  fs.mkdirSync(pwragentHome, { recursive: true });

  const sourceGitEnv = { ...process.env };
  const localGitVariables = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" });
  for (const key of localGitVariables.trim().split(/\s+/)) {
    delete sourceGitEnv[key];
    delete process.env[key];
  }
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = os.devNull;
  process.env.PWRAGENT_HOME = pwragentHome;
  process.env.PWRAGENT_PROFILE = "eval";
  process.env.PWRAGENT_DISABLE_MESSAGING = "1";

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
      `full_access_risk_warning_dismissed = ${allowFullAccess}`,
      "token_miser_enabled = false",
      "",
      "[acp_agents.antigravity]",
      "enabled = true",
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
  fs.mkdirSync(logDirectory, { recursive: true });
  const mainLogPath = path.join(
    logDirectory,
    `profile-${resolveActiveProfileName()}.main.log`,
  );

  initializeMainLogger({
    profileName: resolveActiveProfileName(),
    logDirectory,
    appName: "PwrAgent Eval",
    consoleEnabled: !blind,
  });

  const desktopRoot = path.join(repoCwd, "apps/desktop");
  const runtimePolicy: OwnerRuntimePolicy = {
    ...createOutpostRuntimePolicy(),
    enabledBackends: requiredBackends,
    codexOpenAiProviderEnabled: true,
    approvals: "ask",
    agentNetwork: false,
    memberRole: "full",
    executionModes: allowFullAccess ? ["default", "full-access"] : ["default"],
    sandboxByMode: allowFullAccess
      ? { default: "read-only", "full-access": "danger-full-access" }
      : { default: "read-only" },
  };
  const host = createHeadlessOwnerHostServices({
    runtime: {
      version: "1.5.0-eval",
      isPackaged: false,
      appRoot: desktopRoot,
      resourcesPath: path.join(desktopRoot, "resources"),
    },
    profileDirectory,
    runtimePolicy,
    onQuit: () => {},
  });

  console.log(blind ? "[eval] Booting headless PwrAgent owner for a blind cohort." :
    `[eval] Booting headless PwrAgent owner (repo=${repoCwd}, out=${outDir}, workspaces=${workspacesDir})...`);
  const services = await startOwnerServices(host, {
    bootMode: "active-profile",
    startedAt: Date.now(),
  });
  services.prewarm(issueProviderDiscoveryPermit("startup"));

  const registry = services.registry;
  let unsubscribe: (() => void) | undefined;

  try {
    let backendsList: Awaited<ReturnType<typeof registry.listBackends>>["backends"] = [];
    const getModels = (entry: (typeof backendsList)[number] | undefined) =>
      entry?.launchpadOptions?.models?.length
        ? entry.launchpadOptions.models
        : (entry?.acp?.runtime?.models?.availableModels ?? []);
    function selectNeonModel(entry: (typeof backendsList)[number] | undefined) {
      const models = getModels(entry);
      return models.find((model) => model.id === neonModelOverride)?.id
        ?? (explicitNeonModel ? undefined : models.find((model) => /neon/i.test(model.id))?.id);
    }

    const needsCodex = requestedArms.some(isCodexArm);
    const waitStart = Date.now();
    let refreshedAgy = false;
    for (;;) {
      const res = await registry.listBackends({ includeUnavailable: true });
      backendsList = res.backends;
      const agyEntry = backendsList.find((b) => b.kind === "acp:antigravity");
      if (
        requestedArms.includes("neon")
        && !refreshedAgy
        && agyEntry?.available
        && getModels(agyEntry).length === 0
      ) {
        refreshedAgy = true;
        console.log("[eval] Hydrating acp:antigravity model catalog via warmup session...");
        let warmupCwd: string | undefined;
        try {
          warmupCwd = await initReviewWorkspace(workspacesDir, "catalog", undefined);
          await registry.startThread({
            backend: "acp:antigravity",
            cwd: warmupCwd,
            executionMode,
          });
        } catch (err) {
          console.warn("[eval] acp:antigravity warmup session warning:", String(err));
        } finally {
          if (warmupCwd && !keepWorkspaces) {
            fs.rmSync(warmupCwd, { recursive: true, force: true });
          }
        }
        const refreshed = await registry.listBackends({ includeUnavailable: true });
        backendsList = refreshed.backends;
      }
      const codexOk =
        !needsCodex
        || (() => {
          const e = backendsList.find((b) => b.kind === "codex");
          return Boolean(e?.available && getModels(e).some((m) => m.id === codexModelOverride));
        })();
      const neonOk =
        !requestedArms.includes("neon")
        || (() => {
          const e = backendsList.find((b) => b.kind === "acp:antigravity");
          const selected = selectNeonModel(e);
          if (explicitNeonModel && e?.available && getModels(e).length && !selected) {
            throw new Error(`Requested Neon model ${neonModelOverride} is unavailable.`);
          }
          return Boolean(e?.available && selected);
        })();
      const claudeEntry = backendsList.find((b) => b.kind === "claude");
      const claudeOk = !nativeCollection || Boolean(claudeEntry?.available
        && (!claudeModel || getModels(claudeEntry).some((model) => model.id === claudeModel)));
      if (codexOk && neonOk && claudeOk) break;
      if (Date.now() - waitStart > 90_000) {
        throw new Error(
          `Timed out waiting for backends ${requiredBackends.join(", ")}. Current: ${JSON.stringify(
            backendsList.map((b) => ({
              kind: b.kind,
              available: b.available,
              models: getModels(b).map((m) => m.id),
              reason: b.unavailableReason,
            })),
          )}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }

    const codexModels = getModels(backendsList.find((b) => b.kind === "codex"));
    const codexModel =
      codexModels.find((m) => m.id === codexModelOverride)?.id ?? codexModelOverride;
    const neonModel = selectNeonModel(backendsList.find((b) => b.kind === "acp:antigravity")) ?? neonModelOverride;
    const neonEffort = neonModel.endsWith("-high") ? undefined : neonEffortOverride;

    console.log(
      `[eval] Backends ready! codex=${codexModel}/${codexEffortOverride} | neon=${neonModel}/${neonEffort ?? "model-pinned"}`,
    );

    console.log(
      `[eval] Running ${selectedCases.length} cases x [${requestedArms.join(", ")}] = ${selectedCases.length * requestedArms.length} reviews (concurrency=${caseConcurrency})`,
    );

    type Waiter = {
      arm: ArmId;
      backend: AppServerBackendKind;
      parentThreadId: string;
      turnId?: string;
      reviewThreadId?: string;
      reviewOutput?: AppServerReviewOutput;
      reviewText?: string;
      reviewerModel?: string;
      nativeSources: Set<string>;
      approvals: Set<string>;
      approvalRequests: ApprovalTelemetry[];
      resolve(result: Outcome): void;
    };
    const waiters = new Map<string, Waiter>();

    function findWaiter(backend: AppServerBackendKind, threadId: string, turnId?: string) {
      return [...waiters.values()].find((w) => w.backend === backend
        && (w.parentThreadId === threadId
          || (w.reviewThreadId === threadId && (!w.turnId || !turnId || w.turnId === turnId))));
    }

    async function answerApproval(backend: AppServerBackendKind, notification: AppServerPendingRequestNotification) {
      if (!approvalMethods.has(notification.method)) return;
      const params = notification.params as Record<string, unknown>;
      const { threadId, turnId, requestId } = notification.params;
      if (typeof threadId !== "string" || typeof requestId !== "string") return;
      const w = findWaiter(backend, threadId, turnId ?? undefined);
      if (!w || w.approvals.has(requestId)) return;
      w.approvals.add(requestId);
      const command = extractApprovalCommand(params);
      w.approvalRequests.push({
        requestId,
        method: notification.method,
        decision: "decline",
        ...(command ? { command } : {}),
      });
      try {
        const decision = notification.method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" }
          : buildPendingRequestResponse(notification, "decline");
        await registry.submitServerRequest({ backend, threadId, requestId, ...(turnId ? { turnId } : {}), response: decision });
      } catch (error) {
        if (!blind) console.warn("[eval] Could not decline a review approval:", error);
      }
    }

    unsubscribe = registry.onEvent((event: AgentEvent) => {
      const { method } = event.notification;
      const params = event.notification.params as Record<string, unknown>;
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (!threadId) return;
      if (approvalMethods.has(method)) {
        void answerApproval(event.backend, event.notification as AppServerPendingRequestNotification);
        return;
      }
      const turn = params.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
      const turnId = typeof params.turnId === "string" ? params.turnId : turn?.id;
      const wait = waiters.get(`${event.backend}:${threadId}`);
      if (!wait) return;
      if (method === "item/completed") {
        const item = params.item as Record<string, unknown> | undefined;
        if (item?.type !== "exitedReviewMode") return;
        const data = item.data as Record<string, unknown> | undefined;
        const extracted = extractReviewFromExitedItem(item, {
          allowPlainTextReview: wait.arm === "codex-native",
        });
        if (extracted.reviewOutput) wait.reviewOutput = extracted.reviewOutput;
        if (extracted.reviewText !== undefined) wait.reviewText = extracted.reviewText;
        if (event.backend === "claude" && typeof item.id === "string" && isNativeClaudeSourceKey(item.id)) {
          wait.nativeSources.add(item.id);
          const reviewer = data?.reviewer as { backend?: string; model?: string } | undefined;
          if (reviewer?.backend === "claude" && typeof reviewer.model === "string") {
            wait.reviewerModel = reviewer.model;
          }
        }
        return;
      }
      if (!isReviewTerminalEventMatch({
        expectedTurnId: wait.turnId,
        eventTurnId: turnId,
        relatedReviewTurnId: event.relatedReviewTurnId,
      })) return;
      if (method === "turn/failed" || (method === "turn/completed" && turn?.status === "failed")) {
        wait.resolve({ status: "failed", error: turn?.error?.message ?? "turn failed" });
      } else if (method === "turn/cancelled" || (method === "turn/completed"
        && (turn?.status === "cancelled" || turn?.status === "interrupted"))) {
        wait.resolve({ status: "cancelled" });
      } else if (method === "turn/completed") {
        wait.resolve({ status: "completed" });
      }
    });

    function interrupt(started: StartReviewResponse) {
      return registry.interruptTurn({ backend: started.backend, threadId: started.threadId, turnId: started.turnId });
    }

    async function runOne(c: CohortCase, arm: ArmId) {
      const outPath = path.join(resultsDir, `${c.id}--${arm}.json`);
      const prNum = c.baseline.prNumber ?? c.pr;
      const backend: AppServerBackendKind = armBackend[arm];
      const model = isCodexArm(arm) ? codexModel : arm === "neon" ? neonModel : claudeModel;
      const reasoningEffort = isCodexArm(arm) ? codexEffortOverride : arm === "neon" ? neonEffort : claudeEffort;
      const identity = createHash("sha256").update(JSON.stringify({
        c, arm, backend, model, reasoningEffort, bundleSha256, repoCwd, executionMode,
        ...(promptSha256 ? { promptSha256 } : {}),
      })).digest("hex");
      if (!force && fs.existsSync(outPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
          if (existing.status === "completed" && existing.structured === true
            && Array.isArray(existing.findings) && existing.findingsCount === existing.findings.length
            && existing.identity === identity) {
            totals.skipped += 1;
            if (!blind) console.log(`[SKIP] ${c.id} | ${arm} | already completed`);
            return;
          }
        } catch {
          // Re-run malformed or obsolete entries.
        }
      }

      const startedAt = Date.now();
      const elapsed = () => Date.now() - startedAt;
      const remaining = () => timeoutMs - elapsed();
      const setupAbort = new AbortController();
      const { signal } = setupAbort;
      let mergeBaseCommit: string | undefined;
      let workspacePath: string | undefined;
      let key: string | undefined;
      let waiter: Waiter | undefined;
      let started: StartReviewResponse | undefined;
      let nativeDispatch: { command: string; dispatchedAt: number } | undefined;
      let outcome: Outcome;
      const timedOut = (stage: string): Outcome => ({ status: "timeout", error: `Timed out during ${stage} after ${timeoutMs}ms` });
      try {
        const setup = await beforeDeadline((async () => {
          await ensureCommitPresent(repoCwd, remote, prNum, c.baseline.baseCommit, sourceGitEnv, signal);
          await ensureCommitPresent(repoCwd, remote, prNum, c.baseline.headCommit, sourceGitEnv, signal);
          const mergeBase = reviewedMergeBase(repoCwd, c.baseline.baseCommit, c.baseline.headCommit);
          const cwd = await checkoutReviewSnapshot({
            source: repoCwd, parent: workspacesDir, name: `${c.id}--${arm}`,
            base: c.baseline.baseCommit, head: c.baseline.headCommit, mergeBase, signal,
          });
          const antigravityAccess = arm === "neon" && !allowFullAccess ? {
            mode: "plan" as const,
            fullAccess: false,
            pinnedPatchFile: await writePinnedReviewPatch(cwd, mergeBase, c.baseline.headCommit, signal),
          } : undefined;
          signal.throwIfAborted();
          const parent = await registry.startThread({
            backend, cwd, executionMode, ...(model ? { model } : {}),
            mcpProviderServersEnabled: false, mcpConnectionIds: [],
            ...(reasoningEffort ? { reasoningEffort } : {}),
          });
          const prUrl =
            c.baseline.prUrl ?? `https://github.com/pwrdrvr/PwrAgent/pull/${prNum}`;
          signal.throwIfAborted();
          await getDesktopOverlayStore().setThreadPullRequests({
            backend,
            threadId: parent.threadId,
            prs: [
              {
                provider: "github",
                repo: "pwrdrvr/PwrAgent",
                number: prNum,
                url: prUrl,
                title: c.baseline.prTitle ?? `PR #${prNum}`,
                state: "open",
                baseRefName: c.baseline.baseBranch || "main",
                headRefName: c.baseline.branch || `pr-${prNum}`,
                baseSha: c.baseline.baseCommit,
                headSha: c.baseline.headCommit,
                source: "branch",
                linkedDirectoryPaths: [cwd],
              } as never,
            ],
            fetchedAt: Date.now(),
          });

          return { parent, prUrl, mergeBase, cwd, antigravityAccess };
        })(), remaining());
        if (setup === deadlineExceeded) {
          setupAbort.abort();
          outcome = timedOut("cell setup");
        } else if (stopReason) {
          outcome = { status: "cancelled", error: stopReason };
        } else {
          const { parent, prUrl, mergeBase, cwd, antigravityAccess } = setup;
          mergeBaseCommit = mergeBase;
          workspacePath = cwd;
          key = `${backend}:${parent.threadId}`;
          let resolve!: Waiter["resolve"];
          const terminal = new Promise<Outcome>((done) => { resolve = done; });
          waiter = {
            arm,
            backend,
            parentThreadId: parent.threadId,
            approvals: new Set(),
            approvalRequests: [],
            nativeSources: new Set(),
            resolve,
          };
          waiters.set(key, waiter);

          const runMode = arm === "codex-native" ? "codex-sub-agent" : "pwragent-sub-agent";
          const request: StartReviewRequest = {
            backend,
            ...(arm === "codex-native" ? {} : { reviewBackend: backend }),
            threadId: parent.threadId,
            runMode,
            cwd,
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            target: {
              type: "pullRequest",
              url: prUrl,
              snapshot: {
                pullRequest: {
                  provider: "github.com",
                  org: "pwrdrvr",
                  repo: "PwrAgent",
                  number: prNum,
                  url: prUrl,
                  ...(c.baseline.prTitle ? { title: c.baseline.prTitle } : {}),
                  baseRefName: c.baseline.baseBranch || "main",
                  headRefName: c.baseline.branch || `pr-${prNum}`,
                },
                baseCommit: c.baseline.baseCommit,
                headCommit: c.baseline.headCommit,
                mergeBaseCommit: mergeBase,
                capturedAt: Date.now(),
              },
            },
          };

          let starting: Promise<StartReviewResponse>;
          if (arm === "claude-native") {
            const command = nativeClaudeReviewCommand(mergeBase, c.baseline.headCommit, claudeEffort);
            nativeDispatch = { command, dispatchedAt: Date.now() };
            starting = registry.startTurn({
              backend, threadId: parent.threadId, input: [{ type: "text", text: command }],
            }).then((turn) => ({ ...turn, reviewThreadId: turn.threadId }));
          } else {
            starting = registry.startReview(request, true, undefined, antigravityAccess);
          }
          const accepted = await beforeDeadline(starting, remaining());
          if (accepted === deadlineExceeded) {
            outcome = timedOut("review start");
            stopReason = "Review acceptance timed out and could not be confirmed.";
            void starting.then(interrupt).catch(() => {});
          } else {
            started = accepted;
            waiter.turnId = started.turnId;
            waiter.reviewThreadId = started.reviewThreadId;
            for (const pending of registry.listPendingServerRequests()) {
              void answerApproval(pending.backend, pending.notification);
            }
            if (!blind) console.log(`[START] ${c.id} | ${arm} (${model ?? "session default"}/${reasoningEffort ?? "model-pinned"})`);
            const result = await beforeDeadline(terminal, remaining());
            if (result === deadlineExceeded) {
              outcome = timedOut("review");
              void interrupt(started).catch(() => {});
              if (await beforeDeadline(terminal, 10_000) === deadlineExceeded) {
                stopReason = "The timed-out review did not confirm termination.";
              }
            } else {
              outcome = result;
              if (outcome.status === "completed" && !Array.isArray(waiter.reviewOutput?.findings)) {
                outcome = { status: "failed", error: "Review completed without structured findings." };
              } else if (outcome.status === "completed" && nativeDispatch && waiter.nativeSources.size !== 1) {
                outcome = { status: "failed", error: "Native review did not produce one identifying artifact." };
              }
            }
          }
        }
      } catch (error) {
        outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (key) waiters.delete(key);
      }

      let usage: CellUsageMetrics | null = null;
      if (waiter?.parentThreadId || started?.reviewThreadId) {
        usage = await readCellUsageFromRegistry(registry, {
          backend,
          parentThreadId: waiter?.parentThreadId,
          reviewThreadId: started?.reviewThreadId,
        });
      }

      const review = waiter?.reviewOutput;
      const findings = review?.findings ?? [];
      const ledger = started ? readLedgerStatsFromLog(mainLogPath, started.turnId) : null;
      const nativeSource = waiter?.nativeSources.values().next().value;
      const approvalRequests = waiter?.approvalRequests ?? [];
      const abortedOnApproval = outcome.status !== "completed" && approvalRequests.length > 0;
      const record = {
        identity,
        caseId: c.id, prNumber: prNum, arm, backend, model: waiter?.reviewerModel ?? model,
        baseCommit: c.baseline.baseCommit, headCommit: c.baseline.headCommit, mergeBaseCommit, workspacePath,
        baseBranch: c.baseline.baseBranch,
        reasoningEffort: reasoningEffort ?? null,
        ...(revLabel ? { revLabel } : {}),
        ...(promptSha256 ? { promptSha256 } : {}),
        status: outcome.status, error: outcome.error ?? null,
        abortedOnApproval,
        elapsedSec: Math.round(elapsed() / 1000),
        approvals: waiter?.approvals.size ?? 0,
        approvalRequests,
        parentThreadId: waiter?.parentThreadId,
        reviewThreadId: started?.reviewThreadId,
        turnId: started?.turnId,
        ...(outcome.status === "completed" && nativeDispatch && nativeSource
          ? { nativeClaude: { ...nativeDispatch, sourceKey: nativeSource } }
          : {}),
        structured: Array.isArray(review?.findings),
        findingsCount: findings.length,
        overallCorrectness: review?.overall_correctness ?? null,
        overallConfidence: review?.overall_confidence_score ?? null,
        overallExplanation: review?.overall_explanation ?? null,
        findings, reviewText: waiter?.reviewText ?? null, ledger, usage,
        completedAt: new Date().toISOString(),
      };
      writeCell(outPath, record);
      if (workspacePath && !keepWorkspaces) {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
      totals[record.status] += 1;
      if (!blind) {
        const tokPart = usage && usage.source !== "none"
          ? ` | ${usage.totalTokens} tok${usage.estimatedCostUsd !== null ? ` ($${usage.estimatedCostUsd.toFixed(4)})` : ""}`
          : "";
        console.log(`[DONE] ${c.id} | ${arm} | ${record.status} | ${record.findingsCount} findings${tokPart}${record.error ? ` | ${record.error}` : ""}`);
      }
    }

    let nextIdx = 0;
    const workers = Array.from(
      { length: Math.min(caseConcurrency, selectedCases.length) },
      async () => {
        while (!stopReason) {
          const idx = nextIdx;
          nextIdx += 1;
          if (idx >= selectedCases.length) return;
          const c = selectedCases[idx]!;
          for (const arm of requestedArms) {
            if (stopReason) break;
            try {
              await runOne(c, arm);
            } catch (error) {
              stopReason = "Could not persist a matrix cell.";
              if (!blind) console.error(stopReason, error);
            }
          }
        }
      },
    );
    await Promise.all(workers);
    console.log(`[eval] Cell totals: ${JSON.stringify(totals)}`);
    if (stopReason) throw new Error(stopReason);
  } finally {
    unsubscribe?.();
    prepareOwnerShutdown();
    try {
      if (await beforeDeadline(disposeOwnerServices("eval-complete"), 10_000) === deadlineExceeded) {
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

main().catch((err) => {
  if (blindOutput) process.stderr.write("[eval] Blind matrix failed. Diagnostic logs are local.\n");
  else console.error("[eval] FATAL:", err);
  process.exit(1);
});
