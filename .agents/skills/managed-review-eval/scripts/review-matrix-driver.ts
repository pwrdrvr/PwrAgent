/**
 * Headless PwrAgent owner eval driver for managed code reviews.
 *
 * Boots startOwnerServices in pure Node with desktop policy (memberRole=full,
 * isolated PWRAGENT_HOME) and executes startReview(request, true) across a
 * verified cohort JSON for Codex and/or Antigravity Neon.
 *
 * Build first via build-eval-driver.mjs, then run:
 *   node .local/managed-review-eval/dist/review-matrix-driver.js \
 *     --repo /path/to/PwrAgnt \
 *     --cohort .agents/skills/managed-review-eval/cohorts/dev-1.json \
 *     --out .local/managed-review-eval/runs/dev-1-baseline \
 *     --arms codex,neon --concurrency 2
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildPendingRequestResponse } from "@pwragent/shared/pending-request-response";
import type {
  AgentEvent,
  StartReviewRequest,
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

function ensureCommitPresent(
  repoCwd: string,
  remote: string,
  prNumber: number,
  sha: string,
): void {
  if (hasCommit(repoCwd, sha)) return;
  try {
    execFileSync(
      "git",
      ["-C", repoCwd, "fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/pull/${prNumber}/head`],
      { stdio: "ignore" },
    );
  } catch {
    // try direct SHA fetch fallback
  }
  if (!hasCommit(repoCwd, sha)) {
    execFileSync(
      "git",
      ["-C", repoCwd, "fetch", "--no-tags", "--no-write-fetch-head", remote, sha],
      { stdio: "ignore" },
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
  const caseConcurrency = Math.max(1, Number(parseArg("--concurrency", "2")));
  const codexModelOverride = parseArg("--codex-model", "gpt-6.2-sol");
  const codexEffortOverride = parseArg("--codex-effort", "xhigh");
  const neonModelOverride = parseArg("--neon-model", "gemini-4-neon");
  const neonEffortOverride = parseArg("--neon-effort", "high");
  const force = process.argv.includes("--force");

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
      "full_access_risk_warning_dismissed = true",
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
  });

  const desktopRoot = path.join(repoCwd, "apps/desktop");
  const baseHost = createHeadlessOwnerHostServices({
    runtime: {
      version: "1.5.0-eval",
      isPackaged: false,
      appRoot: desktopRoot,
      resourcesPath: path.join(desktopRoot, "resources"),
    },
    profileDirectory,
    onQuit: () => {},
  });
  const host = { ...baseHost, runtimePolicy: undefined };

  console.log(`[eval] Booting headless PwrAgent owner (repo=${repoCwd}, out=${outDir})...`);
  const services = await startOwnerServices(host, {
    bootMode: "active-profile",
    startedAt: Date.now(),
  });
  services.prewarm(issueProviderDiscoveryPermit("startup"));

  const registry = services.registry;
  let unsubscribe: (() => void) | undefined;

  try {
    const requestedArms = armsArg
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is ArmId => s === "codex" || s === "neon");

    const requiredBackends: AppServerBackendKind[] = [];
    if (requestedArms.includes("codex")) requiredBackends.push("codex");
    if (requestedArms.includes("neon")) requiredBackends.push("acp:antigravity");

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
            executionMode: "full-access",
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

    const parsedCohort = JSON.parse(fs.readFileSync(cohortPath, "utf8")) as CohortFile;
    const allCases = Array.isArray(parsedCohort) ? parsedCohort : parsedCohort.cases;
    const selectedCases =
      casesArg === "all"
        ? allCases
        : allCases.filter((c) => casesArg.split(",").map((s) => s.trim()).includes(c.id));

    console.log(
      `[eval] Running ${selectedCases.length} cases x [${requestedArms.join(", ")}] = ${selectedCases.length * requestedArms.length} reviews (concurrency=${caseConcurrency})`,
    );

    type Waiter = {
      parentBackend: AppServerBackendKind;
      parentThreadId: string;
      turnId?: string;
      reviewThreadId?: string;
      reviewOutput?: AppServerReviewOutput;
      reviewText?: string;
      reviewer?: unknown;
      approvals: number;
      startedAt: number;
      resolve: (result: {
        status: "completed" | "failed" | "cancelled" | "timeout";
        error?: string;
      }) => void;
    };
    const waiters = new Map<string, Waiter>();

    unsubscribe = registry.onEvent(async (event: AgentEvent) => {
      const method = event.notification.method;
      const params = event.notification.params as Record<string, unknown>;
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined;

      if (method === "serverRequest/requested" && threadId) {
        const req = params as unknown as AppServerPendingRequestNotification["params"] & {
          requestId?: string;
        };
        const w = [...waiters.values()].find(
          (candidate) =>
            candidate.parentBackend === event.backend
            && (candidate.parentThreadId === threadId || candidate.reviewThreadId === threadId),
        );
        if (w) w.approvals += 1;
        try {
          const response = buildPendingRequestResponse(
            event.notification as unknown as AppServerPendingRequestNotification,
            "accept",
          );
          if (response && typeof req.requestId === "string") {
            await registry.submitServerRequest({
              backend: event.backend,
              threadId,
              ...(turnId ? { turnId } : {}),
              requestId: req.requestId,
              response,
            });
          }
        } catch (err) {
          console.warn(`[eval] auto-approve failed for ${threadId}:`, String(err));
        }
        return;
      }

      if (!threadId) return;
      const key = `${event.backend}:${threadId}`;
      const waiter = waiters.get(key);
      if (!waiter) return;
      if (waiter.turnId && turnId && turnId !== waiter.turnId) return;

      if (method === "item/completed") {
        const item = params.item as Record<string, unknown> | undefined;
        if (item?.type === "exitedReviewMode") {
          const data = item.data as Record<string, unknown> | undefined;
          if (data?.reviewOutput) {
            waiter.reviewOutput = data.reviewOutput as AppServerReviewOutput;
          }
          if (typeof item.review === "string") {
            waiter.reviewText = item.review;
          }
          if (data?.reviewer) {
            waiter.reviewer = data.reviewer;
          }
        }
        return;
      }

      if (method === "turn/completed") {
        waiter.resolve({ status: "completed" });
      } else if (method === "turn/failed") {
        const turn = params.turn as { error?: { message?: string } } | undefined;
        waiter.resolve({ status: "failed", error: turn?.error?.message ?? "turn failed" });
      } else if (method === "turn/cancelled") {
        waiter.resolve({ status: "cancelled" });
      }
    });

    async function runOne(c: CohortCase, arm: ArmId) {
      const outPath = path.join(resultsDir, `${c.id}--${arm}.json`);
      if (!force && fs.existsSync(outPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
          if (existing.status === "completed") {
            console.log(
              `[SKIP] ${c.id} | ${arm} | already completed (${existing.findingsCount} findings, ${existing.elapsedSec}s)`,
            );
            return existing;
          }
        } catch {
          // re-run
        }
      }

      const prNum = c.baseline.prNumber ?? c.pr;
      ensureCommitPresent(repoCwd, remote, prNum, c.baseline.baseCommit);
      ensureCommitPresent(repoCwd, remote, prNum, c.baseline.headCommit);

      const backend: AppServerBackendKind = arm === "codex" ? "codex" : "acp:antigravity";
      const model = arm === "codex" ? codexModel : neonModel;
      const reasoningEffort = arm === "codex" ? codexEffortOverride : neonEffort;

      const startedAt = Date.now();
      const parent = await registry.startThread({
        backend,
        cwd: repoCwd,
        executionMode: "full-access",
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });

      const key = `${backend}:${parent.threadId}`;
      let resolveWaiter!: (res: {
        status: "completed" | "failed" | "cancelled" | "timeout";
        error?: string;
      }) => void;
      const donePromise = new Promise<{
        status: "completed" | "failed" | "cancelled" | "timeout";
        error?: string;
      }>((resolve) => {
        resolveWaiter = resolve;
      });

      const waiter: Waiter = {
        parentBackend: backend,
        parentThreadId: parent.threadId,
        approvals: 0,
        startedAt,
        resolve: resolveWaiter,
      };
      waiters.set(key, waiter);

      const prUrl =
        c.baseline.prUrl ?? `https://github.com/pwrdrvr/PwrAgent/pull/${prNum}`;
      const mergeBaseCommit = execFileSync(
        "git",
        ["-C", repoCwd, "merge-base", "--all", c.baseline.baseCommit, c.baseline.headCommit],
        { encoding: "utf8" },
      ).trim();

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
            mergeBaseCommit,
            capturedAt: Date.now(),
          },
        },
      };

      const timer = setTimeout(() => {
        resolveWaiter({ status: "timeout", error: `Timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      try {
        const started = await registry.startReview(request, true);
        waiter.turnId = started.turnId;
        waiter.reviewThreadId = started.reviewThreadId;
        console.log(
          `[START] ${c.id} | ${arm} (${model}${reasoningEffort ? `/${reasoningEffort}` : ""}) | turn=${started.turnId.slice(0, 16)}`,
        );

        const outcome = await donePromise;
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 300));
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const ledger = waiter.turnId
          ? readLedgerStatsFromLog(mainLogPath, waiter.turnId)
          : null;
        const findings = waiter.reviewOutput?.findings ?? [];

        const record = {
          caseId: c.id,
          prNumber: prNum,
          arm,
          backend,
          model,
          reasoningEffort: reasoningEffort ?? null,
          status: outcome.status,
          error: outcome.error ?? null,
          elapsedSec,
          approvals: waiter.approvals,
          parentThreadId: parent.threadId,
          reviewThreadId: started.reviewThreadId,
          turnId: started.turnId,
          structured: Boolean(waiter.reviewOutput),
          findingsCount: findings.length,
          overallCorrectness: waiter.reviewOutput?.overall_correctness ?? null,
          overallConfidence: waiter.reviewOutput?.overall_confidence_score ?? null,
          overallExplanation: waiter.reviewOutput?.overall_explanation ?? null,
          findings,
          reviewText: waiter.reviewText ?? null,
          ledger,
          completedAt: new Date().toISOString(),
        };
        fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
        console.log(
          `[DONE] ${c.id} | ${arm} | ${record.status} | ${elapsedSec}s | structured=${record.structured} | findings=${record.findingsCount} | ledger=${ledger ? `${ledger.total}(K:${ledger.keep}/D:${ledger.drop}/P:${ledger.pending})` : "n/a"} | approvals=${record.approvals}`,
        );
        return record;
      } catch (error) {
        clearTimeout(timer);
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const record = {
          caseId: c.id,
          prNumber: prNum,
          arm,
          backend,
          model,
          reasoningEffort: reasoningEffort ?? null,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          elapsedSec,
          approvals: waiter.approvals,
          structured: false,
          findingsCount: 0,
          findings: [],
          ledger: null,
          completedAt: new Date().toISOString(),
        };
        fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
        console.error(`[FAIL] ${c.id} | ${arm} | ${elapsedSec}s | ${record.error}`);
        return record;
      } finally {
        waiters.delete(key);
      }
    }

    let nextIdx = 0;
    const workers = Array.from(
      { length: Math.min(caseConcurrency, selectedCases.length) },
      async () => {
        for (;;) {
          const idx = nextIdx;
          nextIdx += 1;
          if (idx >= selectedCases.length) return;
          const c = selectedCases[idx]!;
          await Promise.all(requestedArms.map((arm) => runOne(c, arm)));
        }
      },
    );
    await Promise.all(workers);
  } finally {
    unsubscribe?.();
    prepareOwnerShutdown();
    try {
      await disposeOwnerServices("eval-complete");
    } finally {
      if (isAppStateInitialized()) {
        disposeOwnerServicesSync();
        disposeAppState();
      }
    }
  }
}

main().catch((err) => {
  console.error("[eval] FATAL:", err);
  process.exit(1);
});
