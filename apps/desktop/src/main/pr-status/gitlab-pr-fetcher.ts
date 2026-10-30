import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopGlabDiscoverySnapshot, GlabStatus, PrSummary } from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { discoverGlabCommands } from "../settings/glab-discovery";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { resolveGitLabReposForDirectory } from "./git-remote";
import { FORGE_JSON_MAX_BYTES, FORGE_LOG_MAX_BYTES } from "./forge-read-limits";
import type { GitLabTerminalPayload } from "./pr-terminal-details";

const execFileAsync = promisify(execFile);
/** Concurrent `glab` subprocesses admitted at once. */
const API_CONCURRENCY = 3;
export class GitLabReadError extends Error {
  /** `reason` is GitLab's own explanation from a JSON error body, never raw CLI output. */
  constructor(readonly status: number, readonly retryAt?: number, readonly reason?: string) {
    super(status === 413 ? "GitLab response exceeds the download limit (16 MiB logs, 2 MiB metadata). Open the source URL for the full content." : reason ? `GitLab returned HTTP ${status}: ${reason}` : `GitLab returned HTTP ${status}. Check host login, read_api permission and project/job access.`);
  }
}

/** GitLab's `message`/`error` field, flattened. Its shape varies by endpoint. */
function readGitLabErrorReason(body: string): string | undefined {
  try {
    const payload = JSON.parse(body.slice(0, 64 * 1024)) as { message?: unknown; error?: unknown; error_description?: unknown };
    const flatten = (value: unknown): string[] => typeof value === "string" ? [value]
      : Array.isArray(value) ? value.flatMap(flatten)
      : value && typeof value === "object" ? Object.entries(value).flatMap(([key, item]) => flatten(item).map((text) => `${key} ${text}`))
      : [];
    const reason = [...flatten(payload.message), ...flatten(payload.error), ...flatten(payload.error_description)].join("; ");
    return reason ? reason.slice(0, 600) : undefined;
  } catch {
    return undefined;
  }
}

/** Parse only transport metadata; raw CLI errors may contain credentials. */
function readApiBody(output: string): string {
  const status = output.match(/^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n/i);
  if (!status) return output;
  const boundary = output.match(/\r?\n\r?\n/);
  const header = boundary ? output.slice(0, boundary.index) : output;
  const code = Number(status[1]);
  if (code >= 400) {
    const retry = header.match(/^retry-after:\s*([^\r\n]+)/im)?.[1];
    const delay = retry && Number.isFinite(Number(retry)) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? "");
    const reset = Number(header.match(/^(?:ratelimit-reset|x-ratelimit-reset):\s*(\d+)/im)?.[1]) * 1000;
    const retryAt = code === 429 ? Math.max(Date.now() + 60_000, reset || 0, delay || 0) : undefined;
    throw new GitLabReadError(code, retryAt);
  }
  return boundary ? output.slice(boundary.index! + boundary[0].length) : output;
}

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
  /** Attachment uploads only; every other request goes through glab. */
  fetch?: typeof fetch;
};

export type GitLabWriteMethod = "POST" | "PUT" | "DELETE";

/**
 * Credentials remain owned by glab, with one exception: GitLab uploads are
 * multipart, which `glab api` cannot send, so `uploadProjectFile` reads the
 * host's token for that one request. Never include raw subprocess output in
 * errors.
 */
export class GitLabPrFetcher {
  private readonly failures = new Map<string, string>();

  getLastError(host: string): string | undefined {
    return this.failures.get(host);
  }

  private discovery?: { at: number; pending: Promise<DesktopGlabDiscoverySnapshot> };
  private readonly statuses = new Map<string, { at: number; pending: Promise<GlabStatus> }>();
  private readonly requests = new Map<string, Promise<unknown>>();
  private requestSequence = 0;
  private activeWrites = 0;
  private readonly tokens = new Map<string, { at: number; token: string }>();
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
    // A re-check follows a sign-in change; never upload with the previous account's token.
    this.tokens.clear();
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

  /**
   * First-party merge request, note and issue changes. Endpoints are built by
   * the forge tool client, never taken from agent arguments. The JSON body
   * travels in a private temp file, so it never appears in process arguments.
   * Writes are not coalesced: two identical requests are two changes.
   */
  async writeApi<T>(host: string, endpoint: string, method: GitLabWriteMethod, body: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/i.test(host) || host === "github.com") throw new Error("Invalid GitLab hostname.");
    const command = (await this.discover()).selectedCommand;
    if (!command) throw new Error("GitLab CLI is unavailable. Install glab or select its path in Settings → Git.");
    if (this.activeWrites >= API_CONCURRENCY) throw new Error("GitLab request concurrency limit reached.");
    if (this.options.tryTakeRequestToken && !this.options.tryTakeRequestToken()) throw new Error("PR status refresh budget is temporarily exhausted.");
    this.activeWrites++;
    let dir: string | undefined;
    try {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-glab-"));
      const file = path.join(dir, "body.json");
      await fs.writeFile(file, JSON.stringify(body ?? {}), { encoding: "utf8", mode: 0o600 });
      const args = ["api", "--hostname", host, "--method", method, "--include", "--header", "Content-Type: application/json", "--input", file, endpoint];
      let stdout = "";
      let answered = true;
      try {
        stdout = this.options.run
          ? await this.options.run(command, args)
          : (await execFileAsync(command, args, {
            env: { ...buildPwrAgentChildProcessEnv(process.env), GLAB_CHECK_UPDATE: "0", GLAB_SEND_SURVEY: "0", GIT_TERMINAL_PROMPT: "0" },
            signal, timeout: 30_000, maxBuffer: FORGE_JSON_MAX_BYTES + 64 * 1024, encoding: "utf8",
          })).stdout;
      } catch (error) {
        // glab exits nonzero on an HTTP error but still prints the response.
        stdout = error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
        answered = /^HTTP\//i.test(stdout);
      }
      // Raw CLI output can carry credentials, so a failure without a response is reported without it.
      if (!answered) throw new Error(`GitLab request failed on ${host}. Check glab login, api permission, project access, and connectivity.`);
      const status = stdout.match(/^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n/i);
      const boundary = stdout.match(/\r?\n\r?\n/);
      const responseBody = boundary ? stdout.slice(boundary.index! + boundary[0].length) : stdout;
      const code = status ? Number(status[1]) : 200;
      if (code >= 400) {
        const header = boundary ? stdout.slice(0, boundary.index) : stdout;
        const reset = Number(header.match(/^(?:ratelimit-reset|x-ratelimit-reset):\s*(\d+)/im)?.[1]) * 1000;
        throw new GitLabReadError(code, code === 429 ? Math.max(Date.now() + 60_000, reset || 0) : undefined, readGitLabErrorReason(responseBody));
      }
      return (responseBody.trim() ? JSON.parse(responseBody) : null) as T;
    } finally {
      this.activeWrites--;
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** The host's token, for the multipart upload glab cannot send. Cached briefly, never logged. */
  private async readToken(host: string): Promise<string | undefined> {
    const cached = this.tokens.get(host);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.token;
    const command = (await this.discover()).selectedCommand;
    if (!command) return undefined;
    const run = async (args: string[]): Promise<string> => {
      if (this.options.run) {
        try { return await this.options.run(command, args); } catch { return ""; }
      }
      try {
        const output = await execFileAsync(command, args, { env: { ...buildPwrAgentChildProcessEnv(process.env), GLAB_CHECK_UPDATE: "0", GLAB_SEND_SURVEY: "0" }, timeout: 10_000, encoding: "utf8" });
        return `${output.stdout}\n${output.stderr}`;
      } catch (error) {
        return error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      }
    };
    let token: string | undefined = (await run(["config", "get", "token", "--host", host])).trim().split(/\s+/)[0];
    if (!token) token = (await run(["auth", "status", "--hostname", host, "--show-token"])).match(/Token:\s*(\S+)/i)?.[1];
    if (!token || /[^\w.-]/.test(token)) return undefined;
    this.tokens.set(host, { at: Date.now(), token });
    return token;
  }

  /** Upload one file to a project's uploads, returning the Markdown link target GitLab assigns. */
  async uploadProjectFile(host: string, projectPath: string, file: { data: Uint8Array; name: string }, signal?: AbortSignal): Promise<{ url: string }> {
    signal?.throwIfAborted();
    if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/i.test(host) || host === "github.com") throw new Error("Invalid GitLab hostname.");
    if (this.options.tryTakeRequestToken && !this.options.tryTakeRequestToken()) throw new Error("PR status refresh budget is temporarily exhausted.");
    const token = await this.readToken(host);
    if (!token) throw new GitLabReadError(401, undefined, `glab has no token for ${host} to upload attachments. Sign in with glab auth login.`);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.data)]), file.name);
    const timeout = AbortSignal.timeout(120_000);
    const response = await (this.options.fetch ?? fetch)(`https://${host}/api/v4/projects/${encodeURIComponent(projectPath)}/uploads`, {
      method: "POST", body: form, redirect: "error",
      headers: { Authorization: `Bearer ${token}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = (await response.text()).slice(0, 64 * 1024);
    if (!response.ok) throw new GitLabReadError(response.status, undefined, readGitLabErrorReason(text));
    const url = (JSON.parse(text) as { url?: unknown }).url;
    if (typeof url !== "string" || !url.startsWith("/")) throw new Error("GitLab did not return the uploaded file's link.");
    return { url };
  }

  /** Fixed, read-only endpoints constructed by first-party adapters, never agent-supplied URLs. */
  async readApi<T>(host: string, endpoint: string, signal?: AbortSignal, raw = false): Promise<T> {
    return this.api<T>(host, endpoint, true, false, signal, raw, true);
  }

  private async api<T>(host: string, endpoint: string, reportFailure = false, requestTokenTaken = false, signal?: AbortSignal, raw = false, includeHeaders = false): Promise<T> {
    signal?.throwIfAborted();
    if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/i.test(host) || host === "github.com") {
      throw new Error("Invalid GitLab hostname.");
    }
    const command = (await this.discover()).selectedCommand;
    if (!command) throw new Error("GitLab CLI is unavailable. Install glab or select its path in Settings → Git.");
    signal?.throwIfAborted();
    // Independently cancellable callers must not abort another caller's request.
    const key = `${command}\0${host}\0${endpoint}\0${raw}\0${includeHeaders}\0${signal ? ++this.requestSequence : 0}`;
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
        const args = ["api", "--hostname", host, "--method", "GET", ...(includeHeaders ? ["--include"] : []), endpoint];
        const maxBytes = raw ? FORGE_LOG_MAX_BYTES : FORGE_JSON_MAX_BYTES;
        const stdout = this.options.run
          ? await this.options.run(command, args)
          : (await execFileAsync(command, args, {
            env: { ...buildPwrAgentChildProcessEnv(process.env), GLAB_CHECK_UPDATE: "0", GLAB_SEND_SURVEY: "0", GIT_TERMINAL_PROMPT: "0" },
            signal,
            timeout: 15_000,
            maxBuffer: maxBytes + (includeHeaders ? 64 * 1024 : 0),
            encoding: "utf8",
          })).stdout;
        const body = includeHeaders ? readApiBody(stdout) : stdout;
        if (Buffer.byteLength(body, "utf8") > maxBytes) throw new GitLabReadError(413);
        return (raw ? body : JSON.parse(body)) as T;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new GitLabReadError(413);
        if (includeHeaders) {
          if (error instanceof GitLabReadError) throw error;
          if (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string") readApiBody(error.stdout);
        }
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
      // The pane's sign-in field carries the command; this says only what
      // that field cannot — that being signed in already does not rule out a
      // connectivity problem reaching this host.
      return { ...status, reason: `Could not verify login to ${host}. If you are already signed in, check connectivity to that host.` };
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

  /** One MR read for merge details when a merge or close watch fires. */
  async fetchTerminalPayload(ref: GitLabRef): Promise<GitLabTerminalPayload> {
    return await this.api<GitLabTerminalPayload>(ref.host,
      `projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/merge_requests/${ref.number}`, true);
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

  /** MRs whose source head is exactly this commit. An unknown commit is no MR, not a failure. */
  async fetchForCommit(cwd: string, sha: string): Promise<PrSummary[]> {
    const commit = sha.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(commit)) return [];
    const repos = await this.resolveRepos(cwd);
    const prs: PrSummary[] = [];
    // A 404 is also what an inaccessible project returns, so it proves
    // nothing about the host: only a 2xx answer may clear its failure.
    const answeredHosts = new Set<string>();
    for (const repo of repos) {
      let rows: GitLabMrPayload[];
      try {
        rows = await this.api<GitLabMrPayload[]>(repo.host,
          `projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}/repository/commits/${commit}/merge_requests?per_page=20`,
          true, false, undefined, false, true);
      } catch (error) {
        if (error instanceof GitLabReadError && error.status === 404) continue;
        throw error;
      }
      answeredHosts.add(repo.host);
      if (!Array.isArray(rows)) throw new Error("GitLab returned an invalid merge request list.");
      const heads = rows.filter((row) => row.sha?.toLowerCase() === commit);
      for (let index = 0; index < heads.length; index += API_CONCURRENCY) {
        prs.push(...await Promise.all(
          heads.slice(index, index + API_CONCURRENCY)
            .map((row) => this.fetchByRef({ ...repo, number: row.iid })),
        ));
      }
    }
    for (const host of answeredHosts) this.failures.delete(host);
    return prs;
  }
}
