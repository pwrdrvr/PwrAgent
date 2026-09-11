import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DesktopGlabDiscoverySnapshot, GlabStatus, PrSummary } from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { discoverGlabCommands } from "../settings/glab-discovery";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { resolveGitLabReposForDirectory } from "./git-remote";

const execFileAsync = promisify(execFile);
/** Concurrent `glab` subprocesses admitted at once. */
const API_CONCURRENCY = 3;
export type GitLabRef = { host: string; owner: string; repo: string; number: number };

export function parseGitLabMrUrl(value: string): GitLabRef | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hostname === "github.com") return undefined;
    const match = url.pathname.match(/^\/(.+?)\/(?:-\/)?merge_requests\/(\d+)\/?$/);
    if (!match) return undefined;
    const parts = match[1]!.split("/");
    const repo = parts.pop();
    const number = Number(match[2]);
    if (!repo || !parts.length || parts.some((part) => !part) || !Number.isSafeInteger(number) || number < 1) return undefined;
    return { host: url.host.toLowerCase(), owner: parts.join("/"), repo, number };
  } catch {
    return undefined;
  }
}

export type GitLabMrPayload = {
  iid: number;
  web_url: string;
  state: string;
  title?: string;
  draft?: boolean;
  source_branch?: string;
  target_branch?: string;
  sha?: string;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  created_at?: string;
  merged_at?: string;
  closed_at?: string;
  head_pipeline?: { status?: string; web_url?: string; sha?: string; ref?: string; project_id?: number } | null;
};

export function parseGitLabMr(payload: GitLabMrPayload, pipelineSourceHeadSha?: string): PrSummary {
  const ref = parseGitLabMrUrl(payload.web_url);
  if (!ref || ref.number !== payload.iid) throw new Error("GitLab returned an invalid merge request identity.");
  const pipeline = payload.head_pipeline;
  // Synthetic merge/train commits differ from the source head. Their verified
  // source parent is supplied by fetchByRef; an unrelated old head stays unknown.
  const status = pipeline?.sha && payload.sha && pipeline.sha !== payload.sha
    && pipelineSourceHeadSha !== payload.sha ? undefined : pipeline?.status;
  const running = ["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"].includes(status ?? "");
  const checkState = status === "success" ? "passing"
    : status === "failed" || status === "canceled" ? "failing"
    : running ? "pending" : "unknown";
  const lifecycleState = payload.state === "merged" ? "merged"
    : payload.state === "closed" ? "closed" : "open";
  const merge = payload.detailed_merge_status;
  const timestamp = (value?: string): number | undefined => {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    provider: ref.host,
    org: ref.owner,
    repo: ref.repo,
    number: ref.number,
    url: payload.web_url,
    title: payload.title,
    headRefName: payload.source_branch,
    baseRefName: payload.target_branch,
    headSha: payload.sha,
    state: checkState,
    checkState,
    checksStillRunning: running,
    lifecycleState,
    reviewState: payload.draft ? "draft" : "ready_for_review",
    mergeState: payload.has_conflicts || merge === "conflict" ? "conflicting"
      : merge === "mergeable" ? "mergeable" : "unknown",
    failedCheckUrl: checkState === "failing" ? pipeline?.web_url : undefined,
    createdAt: timestamp(payload.created_at),
    mergedAt: lifecycleState === "merged" ? timestamp(payload.merged_at) : undefined,
    closedAt: lifecycleState === "closed" ? timestamp(payload.closed_at) : undefined,
  };
}

export type GitLabPrFetcherOptions = {
  discover?: () => Promise<DesktopGlabDiscoverySnapshot>;
  run?: (command: string, args: string[]) => Promise<string>;
  resolveRepos?: typeof resolveGitLabReposForDirectory;
  tryTakeRequestToken?: () => boolean;
};

/** Credentials remain owned by glab. Never include raw subprocess output in errors. */
export class GitLabPrFetcher {
  private readonly failures = new Map<string, string>();

  getLastError(host: string): string | undefined {
    return this.failures.get(host);
  }

  private discovery?: { at: number; pending: Promise<DesktopGlabDiscoverySnapshot> };
  private readonly statuses = new Map<string, { at: number; pending: Promise<GlabStatus> }>();
  private readonly requests = new Map<string, Promise<unknown>>();
  private readonly options: GitLabPrFetcherOptions;

  constructor(options: GitLabPrFetcherOptions = {}) {
    this.options = options;
  }

  /** The injected resolver, so callers outside this class share the seam. */
  get resolveRepos(): typeof resolveGitLabReposForDirectory {
    return this.options.resolveRepos ?? resolveGitLabReposForDirectory;
  }

  invalidate(): void {
    this.discovery = undefined;
    this.statuses.clear();
  }

  private discover(): Promise<DesktopGlabDiscoverySnapshot> {
    if (!this.discovery || Date.now() - this.discovery.at > 60_000) {
      const pending = this.options.discover?.() ?? discoverGlabCommands({
        configuredCommand: getDesktopSettingsService().resolveGlabCommandPreference(),
      });
      this.discovery = { at: Date.now(), pending };
    }
    return this.discovery.pending;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean((await this.discover()).selectedCommand);
  }

  private async api<T>(host: string, endpoint: string, reportFailure = false, requestTokenTaken = false): Promise<T> {
    if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/i.test(host) || host === "github.com") {
      throw new Error("Invalid GitLab hostname.");
    }
    const command = (await this.discover()).selectedCommand;
    if (!command) throw new Error("GitLab CLI is unavailable. Install glab or select its path in Settings → Git.");
    const key = `${command}\0${host}\0${endpoint}`;
    const existing = this.requests.get(key);
    if (existing) return await existing as T;
    // Reject excess work instead of queueing unbounded subprocesses. Duplicate
    // callers above share the request and do not consume another slot or token.
    if (this.requests.size >= API_CONCURRENCY) throw new Error("GitLab request concurrency limit reached.");
    if (reportFailure && !requestTokenTaken && this.options.tryTakeRequestToken && !this.options.tryTakeRequestToken()) {
      throw new Error("PR status refresh budget is temporarily exhausted.");
    }
    const pending = (async () => {
      try {
        const args = ["api", "--hostname", host, "--method", "GET", endpoint];
        const stdout = this.options.run
          ? await this.options.run(command, args)
          : (await execFileAsync(command, args, {
            env: { ...buildPwrAgentChildProcessEnv(process.env), GLAB_CHECK_UPDATE: "0", GLAB_SEND_SURVEY: "0", GIT_TERMINAL_PROMPT: "0" },
            timeout: 15_000,
            maxBuffer: 2 * 1024 * 1024,
            encoding: "utf8",
          })).stdout;
        return JSON.parse(stdout) as T;
      } catch {
        const message = `GitLab request failed on ${host}. Check glab login, read_api permission, project access, and connectivity.`;
        if (reportFailure) this.failures.set(host, message);
        throw new Error(message);
      }
    })();
    this.requests.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.requests.get(key) === pending) this.requests.delete(key);
    }
  }

  async getAuthStatus(host = "gitlab.com", recheck = false): Promise<GlabStatus> {
    host = host.trim().toLowerCase();
    if (recheck) this.invalidate();
    const cached = this.statuses.get(host);
    if (cached && Date.now() - cached.at < 5 * 60_000) return await cached.pending;
    const pending = this.probeAuth(host);
    this.statuses.set(host, { at: Date.now(), pending });
    return await pending;
  }

  private async probeAuth(host: string): Promise<GlabStatus> {
    const discovery = await this.discover();
    const selected = discovery.candidates.find((candidate) => candidate.selected);
    const status: GlabStatus = {
      host, discovery, command: discovery.selectedCommand, version: selected?.version,
      installed: Boolean(discovery.selectedCommand), loggedIn: false, scopes: [], hasRepoScope: false,
      permissionState: "unknown",
    };
    if (!status.installed) return { ...status, reason: "Install glab or select an executable below." };
    try {
      const user = await this.api<{ username?: string }>(host, "user");
      if (!user.username) throw new Error("No user returned");
      status.loggedIn = true;
      status.account = user.username;
    } catch {
      return { ...status, reason: `Could not verify login to ${host}. Run glab auth login --hostname ${host}, then re-check. Check connectivity if already signed in.` };
    }
    try {
      const token = await this.api<{ scopes?: string[] }>(host, "personal_access_tokens/self");
      status.scopes = token.scopes?.filter((scope) => typeof scope === "string") ?? [];
    } catch {
      // OAuth and older GitLab versions do not expose PAT introspection.
    }
    if (status.scopes.length > 0) {
      status.hasRepoScope = status.scopes.some((scope) => scope === "api" || scope === "read_api");
      status.permissionState = status.hasRepoScope ? "sufficient" : "insufficient";
    } else {
      try {
        await this.api(host, "merge_requests?scope=assigned_to_me&per_page=1");
        status.hasRepoScope = true;
        status.permissionState = "sufficient";
      } catch {
        status.permissionState = "unknown";
      }
    }
    // A connected state carries no reason line: the per-project caveats
    // ("still requires membership or visibility") are only actionable on the
    // merge request that hits them, not in a resting settings pane.
    status.reason = status.hasRepoScope
      ? undefined
      : status.permissionState === "insufficient"
        ? "Merge request status requires read_api or api scope. Update the glab credential and re-check."
        : "Signed in, but merge request read permission could not be verified. Check read_api scope and project access.";
    return status;
  }

  async fetchByRef(ref: GitLabRef, requestTokenTaken = false): Promise<PrSummary> {
    const payload = await this.api<GitLabMrPayload>(ref.host,
      `projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/merge_requests/${ref.number}`, true, requestTokenTaken);
    const pipeline = payload.head_pipeline;
    let pipelineSourceHeadSha: string | undefined;
    if (payload.sha && pipeline?.sha && pipeline.sha !== payload.sha
      && (pipeline.ref === `refs/merge-requests/${ref.number}/merge`
        || pipeline.ref === `refs/merge-requests/${ref.number}/train`)) {
      // GitLab's merged-results/train commit joins the source head to the
      // target (or preceding train entry). Verify that parent, not SHA equality.
      const project = pipeline.project_id ?? `${ref.owner}/${ref.repo}`;
      const commit = await this.api<{ id?: string; parent_ids?: string[] }>(ref.host,
        `projects/${encodeURIComponent(String(project))}/repository/commits/${encodeURIComponent(pipeline.sha)}`, true);
      if (commit.id === pipeline.sha && commit.parent_ids?.includes(payload.sha)) {
        pipelineSourceHeadSha = payload.sha;
      }
    }
    const pr = parseGitLabMr(payload, pipelineSourceHeadSha);
    if (pr.provider !== ref.host || pr.org !== ref.owner || pr.repo !== ref.repo || pr.number !== ref.number) {
      throw new Error("GitLab returned a different merge request identity.");
    }
    this.failures.delete(ref.host);
    return pr;
  }

  async fetchForBranch(cwd: string, branch: string): Promise<PrSummary[]> {
    const repos = await this.resolveRepos(cwd);
    const prs: PrSummary[] = [];
    for (const repo of repos) {
      const prefix = `projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}/merge_requests`;
      // Page the exact source branch; no global project/MR scan.
      for (let page = 1; page <= 10; page++) {
        const rows = await this.api<GitLabMrPayload[]>(repo.host,
          `${prefix}?scope=all&state=all&source_branch=${encodeURIComponent(branch)}&per_page=100&page=${page}`, true);
        if (!Array.isArray(rows)) throw new Error("GitLab returned an invalid merge request list.");
        // The list endpoint omits head_pipeline, so each MR still needs its
        // own read. Run them at the transport's own concurrency bound rather
        // than one at a time — a fourth in flight would be rejected.
        for (let index = 0; index < rows.length; index += API_CONCURRENCY) {
          prs.push(...await Promise.all(
            rows.slice(index, index + API_CONCURRENCY)
              .map((row) => this.fetchByRef({ ...repo, number: row.iid })),
          ));
        }
        // Stop at the cap, but keep the pages already paid for: throwing here
        // discarded 1000 fetched MRs and made the whole provider look failed.
        if (rows.length < 100) break;
      }
    }
    for (const repo of repos) this.failures.delete(repo.host);
    return prs;
  }
}
