/**
 * Headless PwrAgent owner eval driver for managed code reviews.
 *
 * Boots startOwnerServices in pure Node in an isolated PWRAGENT_HOME
 * and executes startReview(request, true) across a
 * verified cohort JSON for Codex and/or Antigravity Neon.
 *
 * Build first via build-eval-driver.mjs, then run:
 *   node .local/managed-review-eval/dist/review-matrix-driver.js \
 *     --repo /path/to/PwrAgnt \
 *     --cohort .agents/skills/managed-review-eval/cohorts/dev-1.json \
 *     --out .local/managed-review-eval/runs/dev-1-baseline \
 *     --arms codex,neon --concurrency 2
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { reviewedMergeBase } from "./review-range.mjs";
import fs from "node:fs";
import path from "node:path";
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

type ArmId = "codex" | "neon";
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
): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected a pinned commit SHA.");
  if (hasCommit(repoCwd, sha)) return;
  try {
    await runFile(
      "git",
      ["-C", repoCwd, "fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/pull/${prNumber}/head`],
      { timeout: 60_000 },
    );
  } catch {
    // try direct SHA fetch fallback
  }
  if (!hasCommit(repoCwd, sha)) {
    await runFile(
      "git",
      ["-C", repoCwd, "fetch", "--no-tags", "--no-write-fetch-head", remote, sha],
      { timeout: 60_000 },
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
      path.join(repoCwd, ".agents/skills/managed-review-eval/cohorts/dev-1.json"),
    ),
  );
  const outDir = path.resolve(
    parseArg("--out", path.join(repoCwd, ".local/managed-review-eval/run")),
  );
  const remote = parseArg("--remote", "origin");
  const casesArg = parseArg("--cases", "all");
  const armsArg = parseArg("--arms", "codex,neon");
  const timeoutMs = Number(parseArg("--timeout-ms", "900000"));
  const caseConcurrency = Number(parseArg("--concurrency", "2"));
  const codexModelOverride = parseArg("--codex-model", "gpt-6.2-sol");
  const codexEffortOverride = parseArg("--codex-effort", "xhigh");
  const neonModelOverride = parseArg("--neon-model", "gemini-4-neon");
  const neonEffortOverride = parseArg("--neon-effort", "high");
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
  const requestedArms = [...new Set(armsArg.split(",").map((arm) => arm.trim()))];
  if (!requestedArms.length || !requestedArms.every((arm): arm is ArmId => arm === "codex" || arm === "neon")) {
    throw new Error("Arms must be codex, neon, or both.");
  }
  const selectedCases = casesArg === "all"
    ? allCases
    : allCases.filter((c) => casesArg.split(",").map((id) => id.trim()).includes(c.id));
  if (!selectedCases.length || selectedCases.some((c) => !/^[A-Za-z0-9_-]+$/.test(c.id))
    || new Set(selectedCases.map((c) => c.id)).size !== selectedCases.length) {
    throw new Error("Select at least one case with a unique, valid case ID.");
  }
  const bundleSha256 = createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
  const requiredBackends: AppServerBackendKind[] = requestedArms.map((arm) =>
    arm === "codex" ? "codex" : "acp:antigravity");
  const totals = { completed: 0, failed: 0, cancelled: 0, timeout: 0, skipped: 0 };
  let stopReason: string | undefined;

  const resultsDir = path.join(outDir, "results");
  const pwragentHome = path.join(outDir, "pwragent-home");
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(pwragentHome, { recursive: true });

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
    `[eval] Booting headless PwrAgent owner (repo=${repoCwd}, out=${outDir})...`);
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
        try {
          await registry.startThread({
            backend: "acp:antigravity",
            cwd: repoCwd,
            executionMode,
          });
        } catch (err) {
          console.warn("[eval] acp:antigravity warmup session warning:", String(err));
        }
        const refreshed = await registry.listBackends({ includeUnavailable: true });
        backendsList = refreshed.backends;
      }
      const codexOk =
        !requestedArms.includes("codex")
        || (() => {
          const e = backendsList.find((b) => b.kind === "codex");
          return Boolean(e?.available && getModels(e).some((m) => m.id === codexModelOverride));
        })();
      const neonOk =
        !requestedArms.includes("neon")
        || (() => {
          const e = backendsList.find((b) => b.kind === "acp:antigravity");
          return Boolean(e?.available && getModels(e).some((m) => m.id === neonModelOverride || /neon/i.test(m.id)));
        })();
      if (codexOk && neonOk) break;
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
    const agyModels = getModels(backendsList.find((b) => b.kind === "acp:antigravity"));
    const codexModel =
      codexModels.find((m) => m.id === codexModelOverride)?.id ?? codexModelOverride;
    const neonModel =
      agyModels.find((m) => m.id === neonModelOverride)?.id
      ?? agyModels.find((m) => /neon/i.test(m.id))?.id
      ?? neonModelOverride;
    const neonEffort = neonModel.endsWith("-high") ? undefined : neonEffortOverride;

    console.log(
      `[eval] Backends ready! codex=${codexModel}/${codexEffortOverride} | neon=${neonModel}/${neonEffort ?? "model-pinned"}`,
    );

    console.log(
      `[eval] Running ${selectedCases.length} cases x [${requestedArms.join(", ")}] = ${selectedCases.length * requestedArms.length} reviews (concurrency=${caseConcurrency})`,
    );

    type Waiter = {
      backend: AppServerBackendKind;
      parentThreadId: string;
      turnId?: string;
      reviewThreadId?: string;
      reviewOutput?: AppServerReviewOutput;
      reviewText?: string;
      approvals: Set<string>;
      resolve(result: Outcome): void;
    };
    const waiters = new Map<string, Waiter>();

    function findWaiter(backend: AppServerBackendKind, threadId: string, turnId?: string) {
      return [...waiters.values()].find((w) => w.backend === backend
        && (w.parentThreadId === threadId || w.reviewThreadId === threadId)
        && (!w.turnId || !turnId || w.turnId === turnId));
    }

    async function answerApproval(backend: AppServerBackendKind, notification: AppServerPendingRequestNotification) {
      if (!approvalMethods.has(notification.method)) return;
      const { threadId, turnId, requestId } = notification.params;
      if (typeof threadId !== "string" || typeof requestId !== "string") return;
      const w = findWaiter(backend, threadId, turnId ?? undefined);
      if (!w || w.approvals.has(requestId)) return;
      w.approvals.add(requestId);
      try {
        // No operator is editing this checkout from the eval process. Provider
        // operations that need wider permissions get a refusal, even in Full Access.
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
      // Parent terminal delivery follows publication of the managed artifact.
      if (!turnId || !wait || (wait.turnId && turnId !== wait.turnId)) return;
      if (method === "item/completed") {
        const item = params.item as Record<string, unknown> | undefined;
        if (item?.type !== "exitedReviewMode") return;
        const data = item.data as Record<string, unknown> | undefined;
        if (data?.reviewOutput) wait.reviewOutput = data.reviewOutput as AppServerReviewOutput;
        if (typeof item.review === "string") wait.reviewText = item.review;
      } else if (method === "turn/failed" || (method === "turn/completed" && turn?.status === "failed")) {
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
      const backend: AppServerBackendKind = arm === "codex" ? "codex" : "acp:antigravity";
      const model = arm === "codex" ? codexModel : neonModel;
      const reasoningEffort = arm === "codex" ? codexEffortOverride : neonEffort;
      const identity = createHash("sha256").update(JSON.stringify({
        c, arm, backend, model, reasoningEffort, bundleSha256, repoCwd, executionMode,
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
      let mergeBaseCommit: string | undefined;
      let key: string | undefined;
      let waiter: Waiter | undefined;
      let started: StartReviewResponse | undefined;
      let outcome: Outcome;
      const timedOut = (stage: string): Outcome => ({ status: "timeout", error: `Timed out during ${stage} after ${timeoutMs}ms` });
      try {
        const setup = await beforeDeadline((async () => {
          await ensureCommitPresent(repoCwd, remote, prNum, c.baseline.baseCommit);
          await ensureCommitPresent(repoCwd, remote, prNum, c.baseline.headCommit);
          const mergeBase = reviewedMergeBase(repoCwd, c.baseline.baseCommit, c.baseline.headCommit);
          const parent = await registry.startThread({
            backend, cwd: repoCwd, executionMode, model, mcpProviderServersEnabled: false, mcpConnectionIds: [],
            ...(reasoningEffort ? { reasoningEffort } : {}),
          });
          const prUrl =
            c.baseline.prUrl ?? `https://github.com/pwrdrvr/PwrAgent/pull/${prNum}`;
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
                linkedDirectoryPaths: [repoCwd],
              } as never,
            ],
            fetchedAt: Date.now(),
          });

          return { parent, prUrl, mergeBase };
        })(), remaining());
        if (setup === deadlineExceeded) {
          outcome = timedOut("cell setup");
        } else if (stopReason) {
          outcome = { status: "cancelled", error: stopReason };
        } else {
          const { parent, prUrl, mergeBase } = setup;
          mergeBaseCommit = mergeBase;
          key = `${backend}:${parent.threadId}`;
          let resolve!: Waiter["resolve"];
          const terminal = new Promise<Outcome>((done) => { resolve = done; });
          waiter = { backend, parentThreadId: parent.threadId, approvals: new Set(), resolve };
          waiters.set(key, waiter);

          const request: StartReviewRequest = {
            backend,
            reviewBackend: backend,
            threadId: parent.threadId,
            runMode: "pwragent-sub-agent",
            cwd: repoCwd,
            model,
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

          const antigravityAccess = arm === "neon" && !allowFullAccess
            ? { mode: "plan" as const, fullAccess: false }
            : undefined;
          const starting = registry.startReview(request, true, undefined, antigravityAccess);
          const accepted = await beforeDeadline(starting, remaining());
          if (accepted === deadlineExceeded) {
            outcome = timedOut("review start");
            stopReason = "Review acceptance timed out and could not be confirmed.";
            // Slow acceptance may arrive while the other admitted cells drain.
            void starting.then(interrupt).catch(() => {});
          } else {
            started = accepted;
            waiter.turnId = started.turnId;
            waiter.reviewThreadId = started.reviewThreadId;
            for (const pending of registry.listPendingServerRequests()) {
              void answerApproval(pending.backend, pending.notification);
            }
            if (!blind) console.log(`[START] ${c.id} | ${arm} (${model}/${reasoningEffort ?? "model-pinned"})`);
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
              }
            }
          }
        }
      } catch (error) {
        outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (key) waiters.delete(key);
      }

      const review = waiter?.reviewOutput;
      const findings = review?.findings ?? [];
      const ledger = started ? readLedgerStatsFromLog(mainLogPath, started.turnId) : null;
      const record = {
        identity,
        caseId: c.id, prNumber: prNum, arm, backend, model,
        baseCommit: c.baseline.baseCommit, headCommit: c.baseline.headCommit, mergeBaseCommit,
        reasoningEffort: reasoningEffort ?? null,
        status: outcome.status, error: outcome.error ?? null,
        elapsedSec: Math.round(elapsed() / 1000),
        approvals: waiter?.approvals.size ?? 0,
        parentThreadId: waiter?.parentThreadId,
        reviewThreadId: started?.reviewThreadId,
        turnId: started?.turnId,
        structured: Array.isArray(review?.findings),
        findingsCount: findings.length,
        overallCorrectness: review?.overall_correctness ?? null,
        overallConfidence: review?.overall_confidence_score ?? null,
        overallExplanation: review?.overall_explanation ?? null,
        findings, reviewText: waiter?.reviewText ?? null, ledger,
        completedAt: new Date().toISOString(),
      };
      writeCell(outPath, record);
      totals[record.status] += 1;
      if (!blind) {
        console.log(`[DONE] ${c.id} | ${arm} | ${record.status} | ${record.findingsCount} findings${record.error ? ` | ${record.error}` : ""}`);
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
          await Promise.all(requestedArms.map((arm) => runOne(c, arm).catch((error) => {
            stopReason = "Could not persist a matrix cell.";
            if (!blind) console.error(stopReason, error);
          })));
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
