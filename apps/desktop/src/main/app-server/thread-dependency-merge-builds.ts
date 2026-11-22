import type {
  ThreadDependencyCondition,
  ThreadDependencyEvidence,
  ThreadDependencyMergeBuildObservation,
} from "@pwragent/shared/contracts/thread-dependencies";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";
import { repositoryUrl } from "../pr-status/forge-tool-contract";

/**
 * Continue After a merge build. When a watched PR merges, the owner finds the
 * commit the merge put on the target branch and checks what reported on it,
 * from the main process: no model, no thread, and no SQLite write per check.
 * The wait ends when every check on that commit has finished.
 */

/** One admitted forge REST GET, relative to the API root. */
export type MergeBuildGet = (repository: ForgeRepository, path: string) => Promise<unknown>;

export type MergeBuildTarget = {
  repository: ForgeRepository;
  mergeCommitSha: string;
  baseBranch?: string;
  /** Epoch milliseconds. */
  mergedAt?: number;
};

/** The evidence reason while a merged PR's build runs. Constant, so checks write nothing. */
export const MERGE_BUILD_WAITING_REASON = "PR merged; waiting for its merge build";
/** Before the merge, the same wait reads as a PR wait. */
export const MERGE_BUILD_WAITING_FOR_MERGE_REASON = "Waiting for PR merge";
/**
 * A finished build is believed only this long after the merge: a slow
 * workflow can register its first check after a fast one has finished.
 */
export const MERGE_BUILD_SETTLE_MS = 60_000;
/** Nothing reporting on the merge commit this long after the merge ends the wait. */
export const MERGE_BUILD_NO_CHECKS_MS = 20 * 60_000;
/** Consecutive checks that could not find the merge commit, or its PR. */
export const MERGE_BUILD_GONE_CHECKS = 3;
/** Any failure that lasts this long ends the wait, so no wait polls forever. */
export const MERGE_BUILD_UNREADABLE_MS = 24 * 60 * 60_000;
/** Checks run at most 2 min apart; a longer gap starts a new failure streak. */
const STREAK_GAP_MS = 15 * 60_000;
/** Up to 300 check runs on one commit. */
const MAX_CHECK_PAGES = 3;
const MAX_FAILED_CHECKS = 12;

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required", "error", "failed"]);
const CANCELLED = new Set(["cancelled", "canceled", "stale"]);
const SKIPPED = new Set(["skipped"]);
const PASSED = new Set(["success", "neutral"]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The forge returned an invalid object.");
  return value as Record<string, unknown>;
}

function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("The forge returned an invalid list.");
  return value.map(record);
}

/** Provider text is data: one line, no control characters, bounded. */
function label(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

/** A provider link on the repository's own host, else the commit page. */
function link(value: unknown, fallback: string): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" && !url.username && !url.password && url.host === new URL(fallback).host) return `${url.origin}${url.pathname}`;
  } catch { /* Use the commit page. */ }
  return fallback;
}

/**
 * The merge commit a merged PR's terminal details name. A lookup that failed
 * is not cached and is asked again at the next check, so it is an ordinary
 * read failure. Only a forge answer without a merge commit is `not_found`,
 * which ends the wait after a few checks.
 */
export function mergeCommitOf(details: { mergeCommitSha?: string; detailsUnavailableReason?: string } | undefined): string {
  if (details?.mergeCommitSha) return details.mergeCommitSha;
  if (details?.detailsUnavailableReason) throw new Error(details.detailsUnavailableReason);
  throw Object.assign(new Error("The forge has not reported the merge commit."), { code: "not_found" });
}

type Check = { name: string; url: string; state: "passed" | "failed" | "cancelled" | "skipped" | "running" | "queued" };

/** Every check on the merge commit, in the one vocabulary `evaluateMergeBuildCondition` reads. */
export async function readMergeBuild(get: MergeBuildGet, target: MergeBuildTarget, now: number): Promise<ThreadDependencyMergeBuildObservation> {
  const checks = target.repository.provider === "gitlab" ? await readGitlabPipelines(get, target) : await readGithubChecks(get, target);
  return observe(target, checks, now);
}

async function readGithubChecks(get: MergeBuildGet, target: MergeBuildTarget): Promise<Check[]> {
  const { repository, mergeCommitSha } = target;
  const commit = `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/commits/${encodeURIComponent(mergeCommitSha)}`;
  const fallback = `${repositoryUrl(repository)}/commit/${mergeCommitSha}`;
  const checks: Check[] = [];
  for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
    const body = record(await get(repository, `${commit}/check-runs?filter=latest&per_page=100&page=${page}`));
    const rows = list(body.check_runs);
    for (const row of rows) {
      const status = typeof row.status === "string" ? row.status : "queued";
      const conclusion = typeof row.conclusion === "string" ? row.conclusion : undefined;
      checks.push({
        name: label(row.name) ?? "check",
        url: link(row.html_url ?? row.details_url, fallback),
        state: status !== "completed" ? (status === "in_progress" ? "running" : "queued") : classify(conclusion ?? "unknown"),
      });
    }
    if (rows.length < 100 || typeof body.total_count !== "number" || checks.length >= body.total_count) break;
  }
  // Commit statuses from other CI systems. The combined endpoint lists the
  // latest status per context.
  const combined = record(await get(repository, `${commit}/status?per_page=100`));
  for (const row of list(combined.statuses ?? [])) {
    const state = typeof row.state === "string" ? row.state : "pending";
    checks.push({
      name: label(row.context) ?? "status",
      url: link(row.target_url, fallback),
      state: state === "pending" ? "running" : classify(state),
    });
  }
  return checks;
}

/** GitLab: each pipeline for the merge commit on the target branch is one check. */
async function readGitlabPipelines(get: MergeBuildGet, target: MergeBuildTarget): Promise<Check[]> {
  const { repository, mergeCommitSha, baseBranch } = target;
  const query = new URLSearchParams({ sha: mergeCommitSha, per_page: "20" });
  if (baseBranch) query.set("ref", baseBranch);
  const rows = list(await get(repository, `projects/${encodeURIComponent(`${repository.owner}/${repository.repo}`)}/pipelines?${query}`));
  const fallback = `${repositoryUrl(repository)}/-/commit/${mergeCommitSha}`;
  return rows.map((row) => {
    const status = typeof row.status === "string" ? row.status : "pending";
    const state: Check["state"] = ["created", "waiting_for_resource", "preparing", "pending", "scheduled"].includes(status) ? "queued"
      : status === "running" ? "running"
        // A pipeline that stops at a manual job has nothing left to run by itself.
        : status === "manual" ? "skipped" : classify(status);
    return { name: `Pipeline ${typeof row.id === "number" ? row.id : ""}`.trim(), url: link(row.web_url, fallback), state };
  });
}

function classify(conclusion: string): Check["state"] {
  if (FAILED.has(conclusion)) return "failed";
  if (CANCELLED.has(conclusion)) return "cancelled";
  if (SKIPPED.has(conclusion)) return "skipped";
  if (PASSED.has(conclusion)) return "passed";
  // An unknown finished conclusion is not a pass.
  return "failed";
}

function observe(target: MergeBuildTarget, checks: Check[], now: number): ThreadDependencyMergeBuildObservation {
  const count = (state: Check["state"]) => checks.filter((check) => check.state === state).length;
  const counts = {
    total: checks.length, passed: count("passed"), failed: count("failed"), cancelled: count("cancelled"),
    running: count("running"), queued: count("queued"), skipped: count("skipped"),
  };
  const finished = counts.running === 0 && counts.queued === 0;
  const failedChecks = checks.filter((check) => check.state === "failed").slice(0, MAX_FAILED_CHECKS)
    .map(({ name, url }) => ({ name, url }));
  return {
    mergeCommitSha: target.mergeCommitSha,
    ...target.baseBranch ? { baseBranch: target.baseBranch } : {},
    ...target.mergedAt !== undefined ? { mergedAt: target.mergedAt } : {},
    status: checks.length === 0 ? "no_checks" : finished ? "completed" : "running",
    ...checks.length && finished
      ? { conclusion: counts.failed ? "failure" as const : counts.cancelled ? "cancelled" as const : "success" as const }
      : {},
    checks: counts,
    ...failedChecks.length ? { failedChecks } : {},
    checkedAt: now,
  };
}

/**
 * The evidence for a `merge_build` prerequisite. `pr` is the same condition
 * evaluated as `pr_merged`: until the PR merges, the wait reads exactly as a
 * merge wait. After it, a fired outcome is final and the waiting evidence is
 * constant, so checks write nothing; the latest observation lives in memory.
 */
export function evaluateMergeBuildCondition(condition: ThreadDependencyCondition, pr: ThreadDependencyEvidence,
  observation: ThreadDependencyMergeBuildObservation | undefined, previous: ThreadDependencyEvidence | undefined,
  now: number): ThreadDependencyEvidence {
  if (previous && previous.state !== "waiting") return previous;
  if (pr.state === "failed") return { ...pr, condition };
  if (pr.state === "waiting") {
    // A merge seen once is not undone by a later read that lost the PR.
    if (previous?.reason !== MERGE_BUILD_WAITING_REASON) return { ...pr, condition };
  }
  const prFields = { ...pr.prUrl ?? previous?.prUrl ? { prUrl: pr.prUrl ?? previous?.prUrl } : {}, ...pr.headSha ?? previous?.headSha ? { headSha: pr.headSha ?? previous?.headSha } : {} };
  const waiting: ThreadDependencyEvidence = { condition, state: "waiting", reason: MERGE_BUILD_WAITING_REASON, observedAt: now, ...prFields };
  if (!observation) return waiting;
  const fired = (state: "satisfied" | "failed", reason: string): ThreadDependencyEvidence => ({
    condition, state, reason, observedAt: now, ...prFields, mergeBuild: observation,
  });
  const branch = observation.baseBranch ? ` on ${observation.baseBranch}` : "";
  const commit = observation.mergeCommitSha ? ` ${observation.mergeCommitSha.slice(0, 12)}` : "";
  if (observation.error) {
    if (observation.errorCode === "not_found" && (observation.errorChecks ?? 0) >= MERGE_BUILD_GONE_CHECKS) {
      return fired("failed", `Merge build can no longer be read: ${observation.error}`);
    }
    if (observation.failingSince !== undefined && observation.checkedAt - observation.failingSince >= MERGE_BUILD_UNREADABLE_MS) {
      return fired("failed", `Merge build could not be read for 24 hours: ${observation.error}`);
    }
    return waiting;
  }
  const sinceMerge = observation.mergedAt === undefined ? Number.POSITIVE_INFINITY : observation.checkedAt - observation.mergedAt;
  if (observation.status === "no_checks") {
    return sinceMerge >= MERGE_BUILD_NO_CHECKS_MS
      ? fired("failed", `No checks reported on merge commit${commit}${branch} within ${MERGE_BUILD_NO_CHECKS_MS / 60_000} minutes`)
      : waiting;
  }
  if (observation.status !== "completed" || sinceMerge < MERGE_BUILD_SETTLE_MS) return waiting;
  const checks = observation.checks;
  if (observation.conclusion === "failure") {
    const names = (observation.failedChecks ?? []).map((check) => check.name).join(", ").slice(0, 300);
    return fired("failed", `Merge build failed${branch}: ${checks?.failed ?? 0} of ${checks?.total ?? 0} checks failed${names ? ` (${names})` : ""}`);
  }
  if (observation.conclusion === "cancelled") {
    return fired("satisfied", `Merge build cancelled${branch}: ${checks?.cancelled ?? 0} checks cancelled, none failed; a newer push to the branch may have replaced it`);
  }
  return fired("satisfied", `Merge build passed${branch}: ${checks?.passed ?? 0} of ${checks?.total ?? 0} checks passed`);
}

/** The lines a continuation prompt adds for a fired merge build. */
export function describeMergeBuildObservation(observation: ThreadDependencyMergeBuildObservation): string[] {
  const lines = [`  Merge commit ${observation.mergeCommitSha ?? "unknown"}${observation.baseBranch ? ` on ${observation.baseBranch}` : ""}: ${observation.status}${observation.conclusion ? `, ${observation.conclusion}` : ""}`];
  const checks = observation.checks;
  if (checks) {
    const parts = ([["passed", checks.passed], ["failed", checks.failed], ["cancelled", checks.cancelled], ["running", checks.running], ["queued", checks.queued], ["skipped", checks.skipped]] as const)
      .filter(([, count]) => count > 0).map(([name, count]) => `${count} ${name}`);
    lines.push(`  Checks: ${parts.length ? parts.join(", ") : "none reported"}`);
  }
  for (const check of observation.failedChecks ?? []) lines.push(`  Failed check: ${check.name}; ${check.url}`);
  if (observation.error) lines.push(`  Last check failed: ${observation.error}`);
  return lines;
}

/**
 * Folds one check into the last. A failed check keeps what the last good one
 * saw, for display, and counts the failures that decide when a wait gives up.
 */
export function mergeMergeBuildCheck(previous: ThreadDependencyMergeBuildObservation | undefined,
  observation: ThreadDependencyMergeBuildObservation): ThreadDependencyMergeBuildObservation {
  if (!observation.error) {
    // Without the forge's merge time, the first check stands in for it, so
    // the settle and no-checks windows still run instead of passing at once.
    return observation.mergedAt !== undefined ? observation
      : { ...observation, mergedAt: previous?.mergedAt ?? observation.checkedAt };
  }
  const streak = previous?.error && observation.checkedAt - previous.checkedAt <= STREAK_GAP_MS ? previous : undefined;
  const base: ThreadDependencyMergeBuildObservation = { ...previous ?? observation };
  delete base.errorCode;
  return {
    ...base,
    error: observation.error,
    ...observation.errorCode ? { errorCode: observation.errorCode } : {},
    errorChecks: streak && streak.errorCode === observation.errorCode ? (streak.errorChecks ?? 1) + 1 : 1,
    failingSince: streak?.failingSince ?? observation.checkedAt,
    checkedAt: observation.checkedAt,
  };
}
