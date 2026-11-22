import type {
  ThreadDependency,
  ThreadDependencyCiRun,
  ThreadDependencyCiRunObservation,
  ThreadDependencyCondition,
  ThreadDependencyEvidence,
} from "@pwragent/shared/contracts/thread-dependencies";
import type { ThreadTodoCiApproval } from "@pwragent/shared/contracts/thread-todos";
import {
  threadDependencyCiRunId,
  threadDependencyCiRunOutcomes,
} from "@pwragent/shared/contracts/thread-dependencies";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";

/**
 * Continue After a CI run. Neither forge sends an event PwrAgent can receive
 * without an installed app or webhook, so the owner polls each waiting run
 * from the main process: no model, no thread, and no SQLite write per check.
 * A webhook-backed GitHub App would replace the poll.
 */

export type CiRunRef = { repository: ForgeRepository; runId: number; url: string };
/** One admitted forge REST GET, relative to the API root. */
export type CiRunGet = (repository: ForgeRepository, path: string) => Promise<unknown>;
/** The hosts beyond github.com and gitlab.com that the operator authorized. */
export type CiRunUrlOptions = { githubEnterpriseHosts?: readonly string[] };

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d{1,5})?$/;
export const CI_RUN_MAX_GITHUB_ENTERPRISE_HOSTS = 16;

/**
 * `[git] github_enterprise_hosts` as exact hosts. An entry is one hostname,
 * with a port when the server uses one. Anything else is dropped: a wildcard,
 * a URL, a path, a name without a dot, or a host PwrAgent already knows. An
 * entry never matches a subdomain or a suffix. `:443` is dropped, because a
 * URL's host never carries the default port.
 */
export function normalizeGithubEnterpriseHosts(values: readonly unknown[] | undefined): string[] {
  const hosts = new Set<string>();
  for (const value of values ?? []) {
    const host = typeof value === "string" ? value.trim().toLowerCase().replace(/:443$/, "") : "";
    if (HOST.test(host) && host !== "github.com" && host !== "gitlab.com") hosts.add(host);
    if (hosts.size >= CI_RUN_MAX_GITHUB_ENTERPRISE_HOSTS) break;
  }
  return [...hosts];
}

/**
 * A GitHub Actions run or a GitLab pipeline. Automatic reads send the
 * operator's CLI credentials, so an agent-supplied URL may name only
 * github.com, gitlab.com, or a GitHub Enterprise host the operator listed.
 * The host must equal one of those; no pattern widens the list.
 */
export function parseCiRunUrl(value: string, options: CiRunUrlOptions = {}): CiRunRef | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const host = url.host;
  if (host === "gitlab.com") {
    const match = url.pathname.match(/^\/((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/-\/pipelines\/(\d{1,19})\/?$/);
    const runId = Number(match?.[3]);
    if (!match || !Number.isSafeInteger(runId) || runId < 1) return undefined;
    const [owner, repo] = [match[1]!, match[2]!];
    return { repository: { provider: "gitlab", host, owner, repo }, runId, url: `https://${host}/${owner}/${repo}/-/pipelines/${runId}` };
  }
  if (host !== "github.com" && !normalizeGithubEnterpriseHosts(options.githubEnterpriseHosts).includes(host)) return undefined;
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/(\d{1,19})(?:\/attempts\/\d+)?\/?$/);
  if (!match) return undefined;
  const runId = Number(match[3]);
  if (!Number.isSafeInteger(runId) || runId < 1) return undefined;
  const [owner, repo] = [match[1]!, match[2]!];
  return {
    repository: { provider: "github", host, owner, repo }, runId,
    url: `https://${host}/${owner}/${repo}/actions/runs/${runId}`,
  };
}

/** What `ciRun.url` may be, for a refusal. */
export const CI_RUN_URL_FORMS = "https://github.com/<owner>/<repo>/actions/runs/<id>, the same path on a GitHub Enterprise host listed in [git] github_enterprise_hosts, or https://gitlab.com/<group>/<project>/-/pipelines/<id>";

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const SUCCEEDED = new Set(["success", "neutral", "skipped"]);
/** Up to 1,000 jobs per check. */
const MAX_JOB_PAGES = 10;
/** Consecutive 404s that show a run is gone, not a passing GitHub fault. */
export const CI_RUN_GONE_CHECKS = 3;
/** Any failure that lasts this long ends the wait, so no wait polls forever. */
export const CI_RUN_UNREADABLE_MS = 24 * 60 * 60_000;
/**
 * Checks run at most 2 min apart. A longer gap (sleep, a paused project, PR
 * polling off) starts a new failure streak, so unchecked time never counts.
 */
export const CI_RUN_STREAK_GAP_MS = 15 * 60_000;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The forge returned an invalid object.");
  return value as Record<string, unknown>;
}

/** Provider text is data: one line, no control characters, bounded. */
function label(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

/** One check of a run on its forge, in the one vocabulary `evaluateCiRunCondition` reads. */
export async function readCiRun(get: CiRunGet, ref: CiRunRef, now: number): Promise<ThreadDependencyCiRunObservation> {
  return ref.repository.provider === "gitlab" ? await readGitlabPipeline(get, ref, now) : await readGithubRun(get, ref, now);
}

/** GitHub: the run, its latest attempt's jobs, and its pending deployments while it waits. */
async function readGithubRun(get: CiRunGet, ref: CiRunRef, now: number): Promise<ThreadDependencyCiRunObservation> {
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
        if (failedJobs.length < 8) failedJobs.push({ name: label(job.name) ?? `Job ${String(job.id)}`, url: sameHostUrl(job.html_url, ref), ...(step ? { failedStep: step } : {}) });
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

/** A provider link is kept only when it stays on the run's own host. */
function sameHostUrl(value: unknown, ref: CiRunRef): string {
  return typeof value === "string" && value.startsWith(`https://${ref.repository.host}/`) ? value : ref.url;
}

/** GitLab pipeline statuses in the run vocabulary. Anything else is passed through, and waits. */
const GITLAB_PIPELINE: Record<string, { status: string; conclusion?: string }> = {
  success: { status: "completed", conclusion: "success" },
  failed: { status: "completed", conclusion: "failure" },
  canceled: { status: "completed", conclusion: "cancelled" },
  skipped: { status: "completed", conclusion: "skipped" },
  running: { status: "in_progress" },
  canceling: { status: "in_progress" },
  manual: { status: "waiting" },
  created: { status: "queued" },
  pending: { status: "queued" },
  preparing: { status: "queued" },
  scheduled: { status: "queued" },
  waiting_for_resource: { status: "queued" },
  waiting_for_callback: { status: "queued" },
};

/** A read the token may not make, or a feature the project has off, lists nothing. */
async function optionalList(get: CiRunGet, ref: CiRunRef, path: string): Promise<Record<string, unknown>[]> {
  try {
    const body = await get(ref.repository, path);
    return Array.isArray(body) ? body.map(record) : [];
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "forbidden" || code === "not_found") return [];
    throw error;
  }
}

/**
 * GitLab: the pipeline, its jobs without retried ones, and what waits for a
 * person. A gate is a deployment blocked on approval, named by its
 * environment, or a manual job that can be played now, named by the job.
 * A pipeline can succeed while an optional manual job still waits, so a
 * finished pipeline keeps its gates.
 */
async function readGitlabPipeline(get: CiRunGet, ref: CiRunRef, now: number): Promise<ThreadDependencyCiRunObservation> {
  const project = `projects/${encodeURIComponent(`${ref.repository.owner}/${ref.repository.repo}`)}`;
  const base = `${project}/pipelines/${ref.runId}`;
  const pipeline = record(await get(ref.repository, base));
  if (pipeline.id !== ref.runId || typeof pipeline.status !== "string") throw new Error("GitLab returned a different run.");
  const state = GITLAB_PIPELINE[pipeline.status] ?? { status: label(pipeline.status, 40) ?? "unknown" };
  const jobs: Record<string, unknown>[] = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page++) {
    const body = await get(ref.repository, `${base}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(body)) throw new Error("GitLab returned an invalid job list.");
    const rows = body.map(record);
    jobs.push(...rows);
    if (rows.length < 100) break;
  }
  const counts = { total: jobs.length, passed: 0, failed: 0, running: 0, queued: 0, waiting: 0, skipped: 0 };
  const failedJobs: NonNullable<ThreadDependencyCiRunObservation["failedJobs"]> = [];
  const manual: Record<string, unknown>[] = [];
  for (const job of jobs) {
    if (job.status === "success") counts.passed++;
    else if (job.status === "failed") {
      counts.failed++;
      // An allowed failure does not fail its pipeline, so it wakes no wait.
      if (job.allow_failure !== true && failedJobs.length < 8) failedJobs.push({ name: label(job.name) ?? `Job ${String(job.id)}`, url: sameHostUrl(job.web_url, ref) });
    } else if (job.status === "canceled" || job.status === "canceling") counts.failed++;
    else if (job.status === "skipped") counts.skipped++;
    else if (job.status === "running") counts.running++;
    else if (job.status === "manual") { counts.waiting++; manual.push(job); }
    else counts.queued++;
  }
  let gates: NonNullable<ThreadDependencyCiRunObservation["gates"]> = [];
  if (state.conclusion !== "failure" && state.conclusion !== "cancelled") {
    // The deployments API has no pipeline filter; the newest blocked ones are read and matched.
    const blocked = (await optionalList(get, ref, `${project}/deployments?status=blocked&order_by=id&sort=desc&per_page=100`)).flatMap((entry) => {
      const deployable = entry.deployable && typeof entry.deployable === "object" ? record(entry.deployable) : {};
      const owner = deployable.pipeline && typeof deployable.pipeline === "object" ? record(deployable.pipeline) : {};
      const environment = label(entry.environment && typeof entry.environment === "object" ? record(entry.environment).name : undefined);
      if (owner.id !== ref.runId || !environment) return [];
      const summary = entry.approval_summary && typeof entry.approval_summary === "object" ? record(entry.approval_summary) : {};
      const reviewers = (Array.isArray(summary.rules) ? summary.rules.map(record) : []).flatMap((rule) => {
        const name = label(rule.access_level_description, 80);
        return name ? [name] : [];
      });
      return [{ jobId: deployable.id, gate: { environment, reviewers: reviewers.slice(0, 8) } }];
    });
    const deployed = new Set(blocked.map((entry) => entry.jobId));
    // A manual trigger job is a bridge, which the jobs list leaves out.
    const bridges = pipeline.status === "manual" && !blocked.length && !manual.length
      ? (await optionalList(get, ref, `${base}/bridges?per_page=100`)).filter((bridge) => bridge.status === "manual")
      : [];
    gates = [
      ...blocked.map((entry) => entry.gate),
      ...[...manual, ...bridges].filter((job) => !deployed.has(job.id)).map((job) => ({ environment: label(job.name) ?? `Job ${String(job.id)}`, reviewers: [] })),
    ].slice(0, 8);
  }
  return {
    runId: ref.runId,
    status: state.status !== "completed" && gates.length ? "waiting" : state.status,
    ...(label(pipeline.name) ? { name: label(pipeline.name) } : {}),
    ...(state.conclusion ? { conclusion: state.conclusion } : {}),
    ...(typeof pipeline.sha === "string" ? { headSha: pipeline.sha.slice(0, 64) } : {}),
    ...(label(pipeline.ref) ? { branch: label(pipeline.ref) } : {}),
    ...(gates.length ? { gates } : {}),
    jobs: counts,
    ...(failedJobs.length ? { failedJobs } : {}),
    checkedAt: now,
  };
}

function matchingApprovalGates(ciRun: ThreadDependencyCiRun, observation: ThreadDependencyCiRunObservation) {
  const wanted = ciRun.environments?.length ? new Set(ciRun.environments.map((name) => name.toLowerCase())) : undefined;
  return (observation.gates ?? []).filter((gate) => !wanted || wanted.has(gate.environment.toLowerCase()));
}

/** Decorates an open reminder from its owner's saved milestone, including cards raised before notices existed. */
export function ciApprovalsForDependency(dependency: ThreadDependency | undefined, urls?: () => CiRunUrlOptions): ThreadTodoCiApproval[] {
  const approvals = new Map<string, ThreadTodoCiApproval>();
  if (dependency?.status !== "delivered" || dependency.outcome !== "success") return [];
  for (const entry of dependency.evidence) {
    const { ciRun: observation, condition: { ciRun } } = entry;
    if (entry.state !== "satisfied" || observation?.status !== "waiting" || !ciRun
      || !threadDependencyCiRunOutcomes(ciRun).includes("approval_gate")) continue;
    const ref = parseCiRunUrl(ciRun.url, urls?.());
    if (ref?.repository.provider !== "github" || ref.runId !== observation.runId) continue;
    const environments = matchingApprovalGates(ciRun, observation).map((gate) => gate.environment);
    if (environments.length === 0) continue;
    const existing = approvals.get(ref.url);
    approvals.set(ref.url, {
      url: ref.url, runId: ref.runId, repository: `${ref.repository.owner}/${ref.repository.repo}`,
      environments: [...new Set([...(existing?.environments ?? []), ...environments])],
      ref: observation.branch, headSha: observation.headSha,
    });
  }
  return [...approvals.values()];
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
  if (!ciRun || !observation) return waiting;
  const fired = (state: "satisfied" | "failed", reason: string): ThreadDependencyEvidence => ({ condition, state, reason, observedAt: now, ciRun: observation });
  if (observation.error) {
    // A passing failure keeps waiting. A run that is gone, or unreadable for a
    // day, can never reach its milestone, so the wait reports that instead.
    if (observation.errorCode === "not_found" && (observation.errorChecks ?? 0) >= CI_RUN_GONE_CHECKS) {
      return fired("failed", `Run can no longer be read: ${observation.error}`);
    }
    if (observation.failingSince !== undefined && observation.checkedAt - observation.failingSince >= CI_RUN_UNREADABLE_MS) {
      return fired("failed", `Run could not be read for 24 hours: ${observation.error}`);
    }
    return waiting;
  }
  const on = threadDependencyCiRunOutcomes(ciRun);
  const gates = on.includes("approval_gate") ? matchingApprovalGates(ciRun, observation) : [];
  const needsApproval = () => fired("satisfied", `Needs approval: ${gates.map((gate) => gate.environment).join(", ")}`);
  if (observation.status === "completed") {
    const conclusion = observation.conclusion ?? "unknown";
    if (!SUCCEEDED.has(conclusion)) return fired("failed", `Run finished: ${conclusion}`);
    if (on.includes("finished")) return fired("satisfied", `Run finished: ${conclusion}`);
    // A GitLab pipeline can succeed while an optional manual job still waits.
    if (gates.length) return needsApproval();
    return fired("failed", `Run finished (${conclusion}) without ${on.includes("approval_gate") ? "reaching an approval gate" : "a failed job"}`);
  }
  if (on.includes("job_failed") && observation.failedJobs?.length) {
    return fired("failed", `Job failed: ${observation.failedJobs.map((job) => job.name).join(", ").slice(0, 300)}`);
  }
  if (observation.status === "waiting" && gates.length) return needsApproval();
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
  if (observation.error) lines.push(`  Last check failed: ${observation.error}`);
  return lines;
}

/**
 * Folds one check into the last. A failed check keeps what the last good one
 * saw, for display, and counts the failures that decide when a wait gives up.
 */
export function mergeCiRunCheck(previous: ThreadDependencyCiRunObservation | undefined,
  observation: ThreadDependencyCiRunObservation): ThreadDependencyCiRunObservation {
  if (!observation.error) return observation;
  const streak = previous?.error && observation.checkedAt - previous.checkedAt <= CI_RUN_STREAK_GAP_MS ? previous : undefined;
  const base: ThreadDependencyCiRunObservation = { ...previous ?? observation };
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

/** First check at once, then every 30 s for ten minutes, then every 2 min. */
export function ciRunPollDelay(firstCheckedAt: number, now: number): number {
  return now - firstCheckedAt < 10 * 60_000 ? 30_000 : 120_000;
}

type PollerOptions<T = ThreadDependencyCiRunObservation> = {
  /** The runs that waiting prerequisites still need checked now. */
  urls(): string[];
  read(url: string): Promise<T>;
  observe(url: string, observation: T): Promise<void>;
  /** The observation a failed check reports. Defaults to a CI run's. */
  failed?: (url: string, error: string, code: string | undefined, now: number) => T;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/**
 * One timer for every waiting run, armed only while a run is waiting. Checks
 * run one at a time, through the forge client's shared admission and budget.
 */
export class ThreadDependencyCiRunPoller<T = ThreadDependencyCiRunObservation> {
  private readonly runs = new Map<string, { firstCheckedAt?: number; nextAt: number }>();
  private timer: unknown;
  private timerAt?: number;
  private polling = false;
  private disposed = false;

  constructor(private readonly options: PollerOptions<T>) {}

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
        let observation: T;
        try {
          observation = await this.options.read(url);
        } catch (error) {
          const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
          const message = error instanceof Error ? error.message.slice(0, 300) : "Check failed";
          observation = this.options.failed
            ? this.options.failed(url, message, code, now)
            : { runId: Number(threadDependencyCiRunId(url) ?? 0), status: "unknown", error: message,
              ...code ? { errorCode: code } : {}, checkedAt: now } as T;
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
