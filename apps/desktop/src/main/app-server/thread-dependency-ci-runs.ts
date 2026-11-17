import type {
  ThreadDependencyCiRunObservation, ThreadDependencyCondition, ThreadDependencyEvidence,
} from "@pwragent/shared";
import { threadDependencyCiRunId, threadDependencyCiRunOutcomes } from "@pwragent/shared";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";

/**
 * Continue After a CI run. GitHub sends no event PwrAgent can receive without
 * a GitHub App, so the owner polls each waiting run from the main process: no
 * model, no thread, and no SQLite write per check. A webhook-backed GitHub
 * App would replace the poll.
 */

export type CiRunRef = { repository: ForgeRepository; runId: number; url: string };
/** One admitted GitHub REST GET, relative to the API root. */
export type CiRunGet = (repository: ForgeRepository, path: string) => Promise<unknown>;

/**
 * A GitHub Actions run on github.com. Automatic reads send the operator's
 * GitHub credentials, so an agent-supplied URL may name only github.com,
 * the same origin rule as automatic PR reads.
 */
export function parseCiRunUrl(value: string): CiRunRef | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.host !== "github.com" || url.username || url.password) return undefined;
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/(\d{1,19})(?:\/attempts\/\d+)?\/?$/);
  if (!match) return undefined;
  const runId = Number(match[3]);
  if (!Number.isSafeInteger(runId) || runId < 1) return undefined;
  const [owner, repo] = [match[1]!, match[2]!];
  return {
    repository: { provider: "github", host: "github.com", owner, repo }, runId,
    url: `https://github.com/${owner}/${repo}/actions/runs/${runId}`,
  };
}

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const SUCCEEDED = new Set(["success", "neutral", "skipped"]);
/** Up to 1,000 jobs per check. */
const MAX_JOB_PAGES = 10;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub returned an invalid object.");
  return value as Record<string, unknown>;
}

/** Provider text is data: one line, no control characters, bounded. */
function label(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

/** One check: the run, its latest attempt's jobs, and its pending deployments while it waits. */
export async function readCiRun(get: CiRunGet, ref: CiRunRef, now: number): Promise<ThreadDependencyCiRunObservation> {
  const base = `repos/${encodeURIComponent(ref.repository.owner)}/${encodeURIComponent(ref.repository.repo)}/actions/runs/${ref.runId}`;
  const run = record(await get(ref.repository, base));
  if (run.id !== ref.runId || typeof run.status !== "string") throw new Error("GitHub returned a different run.");
  const jobs: Record<string, unknown>[] = [];
  // A large matrix spans pages; a failed job on a later one must still count.
  for (let page = 1; page <= MAX_JOB_PAGES; page++) {
    const body = record(await get(ref.repository, `${base}/jobs?filter=latest&per_page=100&page=${page}`));
    const rows = Array.isArray(body.jobs) ? body.jobs.map(record) : [];
    jobs.push(...rows);
    if (rows.length < 100 || typeof body.total_count !== "number" || jobs.length >= body.total_count) break;
  }
  const counts = { total: jobs.length, passed: 0, failed: 0, running: 0, queued: 0, waiting: 0, skipped: 0 };
  const failedJobs: NonNullable<ThreadDependencyCiRunObservation["failedJobs"]> = [];
  for (const job of jobs) {
    const conclusion = typeof job.conclusion === "string" ? job.conclusion : undefined;
    if (job.status === "completed") {
      if (conclusion && FAILED.has(conclusion)) {
        counts.failed++;
        const steps = Array.isArray(job.steps) ? job.steps.map(record) : [];
        const step = label(steps.find((entry) => typeof entry.conclusion === "string" && FAILED.has(entry.conclusion))?.name);
        if (failedJobs.length < 8) failedJobs.push({ name: label(job.name) ?? `Job ${String(job.id)}`, url: typeof job.html_url === "string" && job.html_url.startsWith("https://github.com/") ? job.html_url : ref.url, ...(step ? { failedStep: step } : {}) });
      } else if (conclusion === "cancelled") counts.failed++;
      else if (conclusion === "skipped") counts.skipped++;
      else counts.passed++;
    } else if (job.status === "in_progress") counts.running++;
    else if (job.status === "waiting") counts.waiting++;
    else counts.queued++;
  }
  let gates: ThreadDependencyCiRunObservation["gates"];
  if (run.status === "waiting") {
    const pending = await get(ref.repository, `${base}/pending_deployments`);
    gates = (Array.isArray(pending) ? pending.map(record) : []).flatMap((entry) => {
      const environment = label(entry.environment && record(entry.environment).name);
      if (!environment) return [];
      const reviewers = (Array.isArray(entry.reviewers) ? entry.reviewers.map(record) : []).flatMap((reviewer) => {
        const who = reviewer.reviewer && typeof reviewer.reviewer === "object" ? record(reviewer.reviewer) : {};
        const name = label(who.login ?? who.slug ?? who.name, 80);
        return name ? [name] : [];
      });
      const timer = typeof entry.wait_timer === "number" && entry.wait_timer > 0 ? { waitTimerMinutes: entry.wait_timer } : {};
      return [{ environment, reviewers: reviewers.slice(0, 8), ...timer }];
    }).slice(0, 8);
  }
  return {
    runId: ref.runId, status: run.status,
    ...(label(run.name) ? { name: label(run.name) } : {}),
    ...(typeof run.conclusion === "string" ? { conclusion: run.conclusion } : {}),
    ...(typeof run.run_attempt === "number" ? { attempt: run.run_attempt } : {}),
    ...(typeof run.head_sha === "string" ? { headSha: run.head_sha.slice(0, 64) } : {}),
    ...(label(run.head_branch) ? { branch: label(run.head_branch) } : {}),
    ...(gates ? { gates } : {}),
    jobs: counts,
    ...(failedJobs.length ? { failedJobs } : {}),
    checkedAt: now,
  };
}

/**
 * The evidence for a `ci_run` prerequisite after one check. A fired outcome
 * is final: the wait is one-shot. While it waits, the evidence is the same
 * whatever the check saw, so checks write nothing; the latest observation
 * lives in memory. A finished run never leaves the wait waiting: an outcome
 * the wait did not ask for that can no longer happen reports a failure.
 */
export function evaluateCiRunCondition(condition: ThreadDependencyCondition, observation: ThreadDependencyCiRunObservation | undefined,
  previous: ThreadDependencyEvidence | undefined, now: number): ThreadDependencyEvidence {
  if (previous && previous.state !== "waiting") return previous;
  const ciRun = condition.ciRun;
  const waiting: ThreadDependencyEvidence = { condition, state: "waiting", reason: `Waiting for run ${threadDependencyCiRunId(ciRun?.url ?? "") ?? ""}`.trimEnd(), observedAt: now };
  if (!ciRun || !observation || observation.error) return waiting;
  const fired = (state: "satisfied" | "failed", reason: string): ThreadDependencyEvidence => ({ condition, state, reason, observedAt: now, ciRun: observation });
  const on = threadDependencyCiRunOutcomes(ciRun);
  if (observation.status === "completed") {
    const conclusion = observation.conclusion ?? "unknown";
    if (!SUCCEEDED.has(conclusion)) return fired("failed", `Run finished: ${conclusion}`);
    if (on.includes("finished")) return fired("satisfied", `Run finished: ${conclusion}`);
    return fired("failed", `Run finished (${conclusion}) without ${on.includes("approval_gate") ? "reaching an approval gate" : "a failed job"}`);
  }
  if (on.includes("job_failed") && observation.failedJobs?.length) {
    return fired("failed", `Job failed: ${observation.failedJobs.map((job) => job.name).join(", ").slice(0, 300)}`);
  }
  if (on.includes("approval_gate") && observation.status === "waiting") {
    const wanted = ciRun.environments?.length ? new Set(ciRun.environments.map((name) => name.toLowerCase())) : undefined;
    const gates = (observation.gates ?? []).filter((gate) => !wanted || wanted.has(gate.environment.toLowerCase()));
    if (gates.length) return fired("satisfied", `Needs approval: ${gates.map((gate) => gate.environment).join(", ")}`);
  }
  return waiting;
}

/** The lines a continuation prompt adds for a fired run: gates, jobs, failures. */
export function describeCiRunObservation(observation: ThreadDependencyCiRunObservation): string[] {
  const lines = [`  Run ${observation.runId}${observation.name ? ` (${observation.name})` : ""}: ${observation.status}${observation.conclusion ? `, ${observation.conclusion}` : ""}${observation.attempt ? `; attempt ${observation.attempt}` : ""}${observation.headSha ? `; head ${observation.headSha.slice(0, 12)}` : ""}${observation.branch ? `; ref ${observation.branch}` : ""}`];
  for (const gate of observation.gates ?? []) {
    lines.push(`  Approval gate ${gate.environment}: reviewers ${gate.reviewers.length ? gate.reviewers.join(", ") : "not listed"}${gate.waitTimerMinutes ? `; wait timer ${gate.waitTimerMinutes} min` : ""}`);
  }
  const jobs = observation.jobs;
  if (jobs) {
    const parts = ([["passed", jobs.passed], ["failed or cancelled", jobs.failed], ["running", jobs.running], ["waiting", jobs.waiting], ["queued", jobs.queued], ["skipped", jobs.skipped]] as const)
      .filter(([, count]) => count > 0).map(([name, count]) => `${count} ${name}`);
    lines.push(`  Jobs (latest attempt): ${parts.length ? parts.join(", ") : "none listed"}`);
  }
  for (const job of observation.failedJobs ?? []) lines.push(`  Failed job: ${job.name}${job.failedStep ? `, step "${job.failedStep}"` : ""}; ${job.url}`);
  return lines;
}

/** First check at once, then every 30 s for ten minutes, then every 2 min. */
export function ciRunPollDelay(firstCheckedAt: number, now: number): number {
  return now - firstCheckedAt < 10 * 60_000 ? 30_000 : 120_000;
}

type PollerOptions = {
  /** The runs that waiting prerequisites still need checked now. */
  urls(): string[];
  read(url: string): Promise<ThreadDependencyCiRunObservation>;
  observe(url: string, observation: ThreadDependencyCiRunObservation): Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/**
 * One timer for every waiting run, armed only while a run is waiting. Checks
 * run one at a time, through the forge client's shared admission and budget.
 */
export class ThreadDependencyCiRunPoller {
  private readonly runs = new Map<string, { firstCheckedAt?: number; nextAt: number }>();
  private timer: unknown;
  private timerAt?: number;
  private polling = false;
  private disposed = false;

  constructor(private readonly options: PollerOptions) {}

  /** Recheck which runs are waiting and arm the timer for the next one. */
  sync(): void {
    if (this.disposed) return;
    const wanted = new Set(this.options.urls());
    for (const url of this.runs.keys()) if (!wanted.has(url)) this.runs.delete(url);
    for (const url of wanted) if (!this.runs.has(url)) this.runs.set(url, { nextAt: this.now() });
    this.arm();
  }

  /** A check the coordinator already made, at registration. */
  checked(url: string): void {
    const now = this.now();
    const entry = this.runs.get(url) ?? { nextAt: now };
    entry.firstCheckedAt ??= now;
    entry.nextAt = now + ciRunPollDelay(entry.firstCheckedAt, now);
    this.runs.set(url, entry);
  }

  dispose(): void {
    this.disposed = true;
    this.runs.clear();
    this.clear();
  }

  private arm(): void {
    if (this.polling) return;
    const next = Math.min(...[...this.runs.values()].map((entry) => entry.nextAt));
    if (!Number.isFinite(next)) { this.clear(); return; }
    if (this.timer !== undefined && this.timerAt === next) return;
    this.clear();
    this.timerAt = next;
    const set = this.options.setTimer ?? ((fn: () => void, ms: number) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; });
    this.timer = set(() => { this.timer = undefined; this.timerAt = undefined; void this.poll(); }, Math.max(0, next - this.now()));
  }

  private clear(): void {
    if (this.timer !== undefined) (this.options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
  }

  private async poll(): Promise<void> {
    if (this.disposed) return;
    this.polling = true;
    try {
      for (const [url, entry] of [...this.runs]) {
        const now = this.now();
        if (entry.nextAt > now) continue;
        entry.firstCheckedAt ??= now;
        let observation: ThreadDependencyCiRunObservation;
        try {
          observation = await this.options.read(url);
        } catch (error) {
          observation = { runId: Number(threadDependencyCiRunId(url) ?? 0), status: "unknown", error: error instanceof Error ? error.message.slice(0, 300) : "Check failed", checkedAt: now };
        }
        entry.nextAt = this.now() + ciRunPollDelay(entry.firstCheckedAt, this.now());
        if (this.disposed) return;
        await this.options.observe(url, observation).catch(() => undefined);
      }
    } finally {
      this.polling = false;
    }
    this.sync();
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}
