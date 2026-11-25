import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopGlabDiscoverySnapshot } from "@pwragent/shared/contracts/settings";
import type { GlabStatus, PrSummary } from "@pwragent/shared/contracts/navigation";
import { FORGE_PRODUCTS } from "@pwragent/shared/forge-product";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { discoverGlabCommands } from "../settings/glab-discovery";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { resolveGitLabReposForDirectory } from "./git-remote";
import { FORGE_JSON_MAX_BYTES, FORGE_LOG_MAX_BYTES } from "./forge-read-limits";
import type { GitLabTerminalPayload } from "./pr-terminal-details";
import { gitlabMergeTrainStatus } from "./pr-merge-queue";

const execFileAsync = promisify(execFile);
/** How long a project whose merge train setting could not be read waits before it is asked again. */
const MERGE_TRAIN_RETRY_MS = 60 * 60_000;
const GRAPHQL_COMPATIBILITY_RETRY_MS = 60 * 60_000;
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
    const retryAt = code === 429 ? Math.max(Date.now() + 60_000, reset || 0, delay || 0) : delay || undefined;
    throw new GitLabReadError(code, retryAt);
  }
  return boundary ? output.slice(boundary.index! + boundary[0].length) : output;
}

export type GitLabRef = { host: string; owner: string; repo: string; number: number };

/** Admission and deferred cadence are owned by the background scheduler. */
export type GitLabPollRequest = {
  takeFirstRequestToken: () => boolean;
  defer: (iid: number) => void;
};

type GitLabPollRoute = { command: string; takeToken: () => boolean };

class GitLabBudgetDeferred extends Error {
  constructor() { super("PR status refresh budget is temporarily exhausted."); }
}

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

type GitLabPollNode = {
  iid: string;
  webUrl: string;
  state: string;
  title: string;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  diffHeadSha: string | null;
  detailedMergeStatus: string | null;
  conflicts: boolean;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headPipeline: {
    status: string; sha: string | null; ref: string | null; path: string | null;
    project: { id: string } | null;
  } | null;
};

type GitLabPollGraphql = {
  data?: { project?: { mergeRequests?: {
    nodes?: Array<GitLabPollNode | null>;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  } | null } | null };
  errors?: Array<{ message?: string; path?: Array<string | number>; extensions?: { code?: string } }>;
};

function pollQuery(project: string, refs: readonly GitLabRef[], first: number, after: string | null): string {
  // GitLab 19.4 charges an IID-filtered connection by first as well as field
  // cost. The eight-node cap leaves room in its default complexity budget.
  const iids = JSON.stringify(refs.map((ref) => String(ref.number)));
  return `query PwrAgentMergeRequestStatus {
    project(fullPath: ${JSON.stringify(project)}) {
      mergeRequests(iids: ${iids}, first: ${first}, after: ${JSON.stringify(after)}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          iid webUrl state title draft sourceBranch targetBranch diffHeadSha
          detailedMergeStatus conflicts createdAt mergedAt closedAt
          headPipeline { status sha ref path project { id } }
        }
      }
    }
  }`;
}

function toPolledMr(node: GitLabPollNode, ref: GitLabRef): GitLabMrPayload | undefined {
  const identity = parseGitLabMrUrl(node.webUrl);
  if (!identity || identity.host !== ref.host || identity.owner !== ref.owner
    || identity.repo !== ref.repo || identity.number !== ref.number) return undefined;
  const pipeline = node.headPipeline;
  // GraphQL can hide a pipeline based on source-head or pipeline-project
  // permissions. Read the REST detail when it cannot prove the observation.
  if (!node.diffHeadSha || !node.detailedMergeStatus || !pipeline?.sha || !pipeline.status
    || typeof node.state !== "string" || typeof node.draft !== "boolean" || typeof node.conflicts !== "boolean") return undefined;
  const projectId = /^gid:\/\/gitlab\/Project\/(\d+)$/.exec(pipeline.project?.id ?? "")?.[1];
  if (pipeline.sha !== node.diffHeadSha && (!pipeline.ref || !projectId)) return undefined;
  let pipelineUrl: string | undefined;
  if (pipeline.path) {
    const url = new URL(pipeline.path, node.webUrl);
    if (url.protocol === "https:" && url.host === ref.host && !url.username && !url.password) pipelineUrl = url.href;
  }
  const status = pipeline.status.toLowerCase();
  if ((status === "failed" || status === "canceled") && !pipelineUrl) return undefined;
  return {
    iid: ref.number, web_url: node.webUrl, state: node.state.toLowerCase(), title: node.title,
    draft: node.draft, source_branch: node.sourceBranch, target_branch: node.targetBranch,
    sha: node.diffHeadSha, detailed_merge_status: node.detailedMergeStatus.toLowerCase(),
    has_conflicts: node.conflicts, created_at: node.createdAt,
    merged_at: node.mergedAt ?? undefined, closed_at: node.closedAt ?? undefined,
    head_pipeline: {
      sha: pipeline.sha, status, ref: pipeline.ref ?? undefined,
      web_url: pipelineUrl, project_id: projectId ? Number(projectId) : undefined,
    },
  };
}

export function parseGitLabMr(payload: GitLabMrPayload, pipelineSourceHeadSha?: string): PrSummary {
  const ref = parseGitLabMrUrl(payload.web_url);
  if (!ref || ref.number !== payload.iid) throw new Error("GitLab returned an invalid merge request identity.");
  const pipeline = payload.head_pipeline;
  // Synthetic merge/train commits differ from the source head. Their verified
  // source parent is supplied by fetchByRef; an unrelated old head stays unknown.
  const status = pipeline?.sha && payload.sha && pipeline.sha !== payload.sha
    && pipelineSourceHeadSha !== payload.sha ? undefined : pipeline?.status;
  const running = ["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"].includes(status ?? "");
  // A skipped pipeline (`[skip ci]`) is final but tested nothing. It passes so
  // a watch can end, and says so, matching a skipped-only GitHub head.
  const skipped = status === "skipped";
  const checkState = status === "success" || skipped ? "passing"
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
    ...(skipped ? { checksAllSkipped: true as const } : {}),
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
  private readonly retryAt = new Map<string, number>();
  private readonly graphqlUnavailableUntil = new Map<string, number>();
  private requestSequence = 0;
  private activeWrites = 0;
  private readonly tokens = new Map<string, { at: number; token: string }>();
  private readonly mergeTrains = new Map<string, Promise<boolean | undefined>>();
  private readonly mergeTrainRetryAt = new Map<string, number>();
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
    this.graphqlUnavailableUntil.clear();
    this.mergeTrains.clear();
    this.mergeTrainRetryAt.clear();
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
    return this.api<T>(host, endpoint, { reportFailure: true, signal, raw, includeHeaders: true });
  }

  private async api<T>(host: string, endpoint: string, options: {
    reportFailure?: boolean;
    signal?: AbortSignal;
    raw?: boolean;
    includeHeaders?: boolean;
    poll?: GitLabPollRoute;
    query?: string;
  } = {}): Promise<T> {
    const { reportFailure, signal, raw, poll, query, includeHeaders = Boolean(poll) } = options;
    signal?.throwIfAborted();
    if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/i.test(host) || host === "github.com") {
      throw new Error("Invalid GitLab hostname.");
    }
    const command = poll?.command ?? (await this.discover()).selectedCommand;
    if (!command) throw new Error("GitLab CLI is unavailable. Install glab or select its path in Settings → Git.");
    signal?.throwIfAborted();
    // Independently cancellable callers must not abort another caller's request.
    const route = `${command}\0${host}`;
    const key = JSON.stringify([route, endpoint, query, raw, includeHeaders, signal ? ++this.requestSequence : 0]);
    for (;;) {
      // Recheck after each wait. An active request may have set Retry-After
      // while this page was waiting for a slot. A denied start costs no token.
      const retryAt = this.retryAt.get(route);
      if (retryAt !== undefined) {
        if (retryAt > Date.now()) throw new GitLabReadError(429, retryAt);
        this.retryAt.delete(route);
      }
      const existing = this.requests.get(key);
      if (existing) return await existing as T;
      if (this.requests.size < API_CONCURRENCY) break;
      // Only the scheduler's bounded batches wait. Manual and detail reads
      // retain their existing concurrency behavior.
      if (!poll) throw new Error("GitLab request concurrency limit reached.");
      await Promise.race([...this.requests.values()].map((request) => request.then(() => {}, () => {})));
    }
    if (poll ? !poll.takeToken() : reportFailure && this.options.tryTakeRequestToken?.() === false) {
      throw new GitLabBudgetDeferred();
    }
    const pending = (async () => {
      try {
        const args = ["api", "--hostname", host, "--method", query ? "POST" : "GET",
          ...(includeHeaders ? ["--include"] : []), ...(query ? ["--raw-field", `query=${query}`] : []), endpoint];
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
        let failure = error;
        if (includeHeaders && error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string") {
          try {
            const body = readApiBody(error.stdout);
            // Some glab versions exit nonzero for GraphQL errors in a 2xx
            // response. Its data and structured errors are still usable.
            if (query && /^HTTP\/[\d.]+ 2\d\d\b/i.test(error.stdout)) return JSON.parse(body) as T;
          } catch (httpError) {
            failure = httpError;
          }
        }
        if (includeHeaders && failure instanceof GitLabReadError) {
          if (failure.retryAt) this.retryAt.set(route, Math.max(this.retryAt.get(route) ?? 0, failure.retryAt));
          throw failure;
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

  /**
   * Whether the project merges through merge trains. A project setting
   * (GitLab Premium), so it is read once per project and kept for the life
   * of the process; the status poll and the merge tool share the answer.
   * GitLab's free tier has no setting, which reads as no. Every MR of a
   * project shares one read, including reads that start together. The read
   * is charged to the PR status budget; when it cannot run (the budget is
   * spent, or GitLab fails) the answer is unknown, the caller treats the
   * project as having no train, and the project is not asked again for
   * `MERGE_TRAIN_RETRY_MS`. A status poll never pays for it per MR.
   */
  async mergeTrainsEnabled(host: string, project: string, poll?: GitLabPollRoute): Promise<boolean | undefined> {
    const command = poll?.command ?? (await this.discover()).selectedCommand;
    if (!command) return undefined;
    const key = JSON.stringify([command, host, project]);
    const retryAt = this.mergeTrainRetryAt.get(key);
    if (retryAt !== undefined && Date.now() < retryAt) return undefined;
    let read = this.mergeTrains.get(key);
    if (!read) {
      read = this.api<{ merge_trains_enabled?: boolean }>(
        host, `projects/${encodeURIComponent(project)}`, { reportFailure: true, includeHeaders: true, poll },
      ).then((payload) => payload?.merge_trains_enabled === true, (error: unknown) => {
        const deferred = error instanceof GitLabBudgetDeferred
          || (error instanceof GitLabReadError && error.retryAt !== undefined);
        if (this.mergeTrains.get(key) === read) {
          this.mergeTrains.delete(key);
          if (!deferred) this.mergeTrainRetryAt.set(key, Date.now() + MERGE_TRAIN_RETRY_MS);
        }
        if (deferred) throw error;
        return undefined;
      });
      this.mergeTrains.set(key, read);
    }
    try {
      return await read;
    } catch (error) {
      if (poll) throw error;
      return undefined;
    }
  }

  /**
   * The MR's merge train car. GitLab answers 404 for an MR that is not on a
   * train, which reads as no car. Any other failure fails the status read, so
   * the poller keeps what it last saw rather than flipping a queued MR to
   * unqueued for a round.
   */
  async readMergeTrainCar(host: string, project: string, iid: number, poll?: GitLabPollRoute): Promise<{
    status?: string; created_at?: string; updated_at?: string; pipeline?: { status?: string } | null;
  } | undefined> {
    try {
      return await this.api(host, `projects/${encodeURIComponent(project)}/merge_trains/merge_requests/${iid}`, { reportFailure: true, includeHeaders: true, poll });
    } catch (error) {
      if (error instanceof GitLabReadError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async readMergeTrain(ref: GitLabRef, pr: PrSummary, poll?: GitLabPollRoute): Promise<PrSummary["mergeQueue"]> {
    const project = `${ref.owner}/${ref.repo}`;
    if (await this.mergeTrainsEnabled(ref.host, project, poll) !== true) return undefined;
    // A merged or closed MR is not polled again, and its train is over.
    const car = pr.lifecycleState === "open" ? await this.readMergeTrainCar(ref.host, project, ref.number, poll) : undefined;
    return gitlabMergeTrainStatus({
      lifecycle: pr.lifecycleState ?? "open",
      enabled: true,
      car: car ? {
        status: car.status ?? null,
        createdAt: car.created_at ?? null,
        updatedAt: car.updated_at ?? null,
        pipelineStatus: car.pipeline?.status ?? null,
      } : null,
    });
  }

  /** The scheduler supplies at most one target project's worth of IIDs. */
  async pollProject(refs: readonly GitLabRef[], request: GitLabPollRequest): Promise<PrSummary[]> {
    const first = refs[0];
    if (!first) return [];
    const { host, owner, repo } = first;
    if (refs.length > FORGE_PRODUCTS.gitlab.pollBatchSize
      || refs.some((ref) => ref.host !== host || ref.owner !== owner || ref.repo !== repo)) {
      throw new Error("GitLab status batch must belong to a single target project.");
    }
    const command = (await this.discover()).selectedCommand;
    if (!command) return [];
    let started = false;
    const poll: GitLabPollRoute = {
      command,
      takeToken: () => {
        if (started) return this.options.tryTakeRequestToken?.() ?? true;
        started = request.takeFirstRequestToken();
        return started;
      },
    };
    const pending = new Map(refs.map((ref) => [ref.number, ref]));
    const results: PrSummary[] = [];
    const accept = async (ref: GitLabRef, read: () => Promise<PrSummary>) => {
      pending.delete(ref.number);
      try {
        results.push(await read());
      } catch (error) {
        if (error instanceof GitLabBudgetDeferred) request.defer(ref.number);
        // Failed observations leave the registry's previous value in place.
      }
    };
    try {
      if (pending.size > 1) {
        for await (const page of this.pollGraphqlPages(host, `${owner}/${repo}`, [...pending.values()], poll)) {
          for (const [index, node] of (page.nodes ?? []).entries()) {
            if (!node || page.errors?.some((error) => error.path?.[3] === index)) continue;
            const ref = pending.get(Number(node.iid));
            if (!ref) continue;
            let payload: GitLabMrPayload | undefined;
            try { payload = toPolledMr(node, ref); } catch { continue; }
            if (payload) await accept(ref, () => this.observeMr(ref, payload, poll));
          }
          if (pending.size === 0) break;
        }
      }
      // Older schemas, missing nodes, and moved projects use the same detail
      // endpoint as a manual refresh. The REST list omits head_pipeline and
      // includes full descriptions, so it cannot replace these reads.
      for (const ref of pending.values()) await accept(ref, () => this.readMr(ref, poll));
    } catch (error) {
      if (error instanceof GitLabBudgetDeferred) {
        for (const iid of pending.keys()) request.defer(iid);
      }
    }
    return results;
  }

  private async *pollGraphqlPages(host: string, project: string, refs: readonly GitLabRef[], poll: GitLabPollRoute) {
    const route = `${poll.command}\0${host}`;
    if ((this.graphqlUnavailableUntil.get(route) ?? 0) > Date.now()) return;
    let first = refs.length;
    let after: string | null = null;
    const cursors = new Set<string>();
    while (cursors.size < refs.length) {
      let response: GitLabPollGraphql;
      try {
        response = await this.api<GitLabPollGraphql>(host, "graphql", {
          reportFailure: true, poll, query: pollQuery(project, refs, first, after),
        });
      } catch (error) {
        if (!(error instanceof GitLabReadError) || error.retryAt) throw error;
        if (error.status === 413 && first > 1) {
          first = Math.floor(first / 2);
          continue;
        }
        if ([404, 405, 501].includes(error.status)) {
          this.graphqlUnavailableUntil.set(route, Date.now() + GRAPHQL_COMPATIBILITY_RETRY_MS);
          return;
        }
        if ([400, 413, 422].includes(error.status)) return;
        throw error;
      }
      const page = response.data?.project?.mergeRequests;
      if (!page) {
        if (response.errors?.some((error) => /complexity/i.test(error.message ?? "")) && first > 1) {
          first = Math.floor(first / 2);
          continue;
        }
        if (response.errors?.some((error) => ["undefinedField", "argumentNotAccepted"].includes(error.extensions?.code ?? ""))) {
          this.graphqlUnavailableUntil.set(route, Date.now() + GRAPHQL_COMPATIBILITY_RETRY_MS);
        }
        return;
      }
      yield { ...page, errors: response.errors };
      const cursor = page.pageInfo?.endCursor;
      if (!page.pageInfo?.hasNextPage || !cursor || cursors.has(cursor)) return;
      cursors.add(cursor);
      after = cursor;
    }
  }

  async fetchByRef(ref: GitLabRef): Promise<PrSummary> {
    return await this.readMr(ref);
  }

  private async readMr(ref: GitLabRef, poll?: GitLabPollRoute): Promise<PrSummary> {
    const payload = await this.api<GitLabMrPayload>(ref.host,
      `projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/merge_requests/${ref.number}`, { reportFailure: true, poll });
    return await this.observeMr(ref, payload, poll);
  }

  private async observeMr(ref: GitLabRef, payload: GitLabMrPayload, poll?: GitLabPollRoute): Promise<PrSummary> {
    const pipeline = payload.head_pipeline;
    let pipelineSourceHeadSha: string | undefined;
    if (payload.sha && pipeline?.sha && pipeline.sha !== payload.sha
      && (pipeline.ref === `refs/merge-requests/${ref.number}/merge`
        || pipeline.ref === `refs/merge-requests/${ref.number}/train`)) {
      // GitLab's merged-results/train commit joins the source head to the
      // target (or preceding train entry). Verify that parent, not SHA equality.
      const project = pipeline.project_id ?? `${ref.owner}/${ref.repo}`;
      const commit = await this.api<{ id?: string; parent_ids?: string[] }>(ref.host,
        `projects/${encodeURIComponent(String(project))}/repository/commits/${encodeURIComponent(pipeline.sha)}`, { reportFailure: true, poll });
      if (commit.id === pipeline.sha && commit.parent_ids?.includes(payload.sha)) {
        pipelineSourceHeadSha = payload.sha;
      }
    }
    const pr = parseGitLabMr(payload, pipelineSourceHeadSha);
    // A renamed or transferred project's old path redirects to
    // projects/<id>, and glab follows it, so the MR comes back under the
    // project's current path. That path is the answer, not a mismatch: the
    // caller learns the rename from it. Only the host and MR number must hold.
    if (pr.provider !== ref.host || pr.number !== ref.number) {
      throw new Error("GitLab returned a different merge request identity.");
    }
    this.failures.delete(ref.host);
    const mergeQueue = await this.readMergeTrain({ ...ref, owner: pr.org, repo: pr.repo }, pr, poll);
    return mergeQueue ? { ...pr, mergeQueue } : pr;
  }

  /** One MR read for merge details when a merge or close watch fires. */
  async fetchTerminalPayload(ref: GitLabRef): Promise<GitLabTerminalPayload> {
    return await this.api<GitLabTerminalPayload>(ref.host,
      `projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/merge_requests/${ref.number}`, { reportFailure: true });
  }

  async fetchForBranch(cwd: string, branch: string): Promise<PrSummary[]> {
    const repos = await this.resolveRepos(cwd);
    const prs: PrSummary[] = [];
    for (const repo of repos) {
      const prefix = `projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}/merge_requests`;
      // Page the exact source branch; no global project/MR scan.
      for (let page = 1; page <= 10; page++) {
        const rows = await this.api<GitLabMrPayload[]>(repo.host,
          `${prefix}?scope=all&state=all&source_branch=${encodeURIComponent(branch)}&per_page=100&page=${page}`, { reportFailure: true });
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
          { reportFailure: true, includeHeaders: true });
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
