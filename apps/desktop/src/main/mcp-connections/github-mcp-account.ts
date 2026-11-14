import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  GITHUB_MCP_HOSTED_URL,
  githubMcpHostedHeaders,
  type GithubMcpAccountCheck,
  type GithubMcpAccountSource,
  type GithubMcpSettings,
} from "@pwragent/shared";

/**
 * Where a GitHub connection's token comes from, and what GitHub says about it.
 *
 * Two sources, one state machine:
 *
 * - `gh_cli`: ask the GitHub CLI for its github.com token. No `gh` is
 *   `gh_missing`; a `gh` that answers with nothing or fails is `signed_out`.
 *   The token is read on every connect and never stored, so `gh auth
 *   refresh` or a switch of account applies to the next connect.
 * - `token`: a pasted token, or the one stored encrypted for the connection.
 *   None, or one storage cannot give back, is `token_missing`.
 *
 * A token that was read is then shown to GitHub once (`GET /user`): 401 is
 * `rejected`; any other failure is `unreachable`, which does not block,
 * because the MCP server may still answer; success is `ready`, with the
 * login and the classic scopes GitHub reported.
 *
 * The token is returned to the caller that will send it and to nothing else:
 * no check result, message or log line carries it.
 */

export const GITHUB_API_USER_URL = "https://api.github.com/user";
const ACCOUNT_CHECK_TIMEOUT_MS = 10_000;
/** A github.com login, or an app's bot login. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const GITHUB_SCOPE = /^[a-z][a-z_:]{0,63}$/;
const MAX_TOKEN_LENGTH = 1_024;

export type GithubMcpTokenSources = {
  /** The `gh` executable, or undefined when none is installed. */
  findGh: () => Promise<string | undefined>;
  /** `gh`'s github.com token. Null or a throw means it is signed out. */
  readGhToken: (command: string) => Promise<string | null>;
  /** The connection's stored token, or undefined. Throws when unreadable. */
  readStoredToken: () => Promise<string | undefined>;
};

export type GithubMcpTokenRead =
  | { ok: true; token: string }
  | { ok: false; state: "gh_missing" | "signed_out" | "token_missing" };

/**
 * A pasted token, trimmed, or undefined when there is none. Throws for a
 * value that cannot be a token, so the form says so before anything runs.
 */
export function normalizeGithubMcpToken(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Enter the personal access token as text.");
  const token = value.trim();
  if (!token) return undefined;
  if (token.length > MAX_TOKEN_LENGTH || /\s/u.test(token)) {
    throw new Error("That does not look like a GitHub token. Paste it again without spaces or line breaks.");
  }
  return token;
}

/**
 * Read the token one connect will send. A pasted token wins over a stored
 * one, so Test in an edit checks what the form holds.
 */
export async function readGithubMcpToken(
  source: GithubMcpAccountSource,
  sources: GithubMcpTokenSources,
  pastedToken?: string,
): Promise<GithubMcpTokenRead> {
  if (source === "token") {
    if (pastedToken) return { ok: true, token: pastedToken };
    let stored: string | undefined;
    try {
      stored = await sources.readStoredToken();
    } catch {
      return { ok: false, state: "token_missing" };
    }
    const token = stored?.trim();
    return token ? { ok: true, token } : { ok: false, state: "token_missing" };
  }
  const command = await sources.findGh().catch(() => undefined);
  if (!command) return { ok: false, state: "gh_missing" };
  let token: string | null;
  try {
    token = await sources.readGhToken(command);
  } catch {
    // The error can quote gh's output, which can hold a token. Drop it.
    return { ok: false, state: "signed_out" };
  }
  const trimmed = token?.trim();
  return trimmed ? { ok: true, token: trimmed } : { ok: false, state: "signed_out" };
}

/** Classic scopes from `X-OAuth-Scopes`; undefined when GitHub sent none. */
export function parseGithubScopesHeader(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  const scopes: string[] = [];
  for (const part of value.split(",")) {
    const scope = part.trim();
    if (GITHUB_SCOPE.test(scope) && !scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

/**
 * Show a token to GitHub once and classify the answer. Never throws: a
 * network failure is `unreachable`, not an error the form has to parse.
 */
export async function describeGithubMcpToken(
  source: GithubMcpAccountSource,
  token: string,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<GithubMcpAccountCheck> {
  let response: Response;
  try {
    response = await fetchFn(GITHUB_API_USER_URL, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "PwrAgent",
        "x-github-api-version": "2022-11-28",
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(ACCOUNT_CHECK_TIMEOUT_MS)])
        : AbortSignal.timeout(ACCOUNT_CHECK_TIMEOUT_MS),
    });
  } catch {
    return { source, state: "unreachable" };
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    return { source, state: "rejected" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { source, state: "unreachable" };
  }
  const scopes = parseGithubScopesHeader(response.headers.get("x-oauth-scopes"));
  let login: string | undefined;
  try {
    const body = await response.json() as { login?: unknown };
    if (typeof body.login === "string" && GITHUB_LOGIN.test(body.login)) login = body.login;
  } catch {
    // A body that is not the user record still came with a 200.
  }
  return {
    source,
    state: "ready",
    ...(login ? { login } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

/** Read the token, then ask GitHub about it. */
export async function checkGithubMcpAccount(
  source: GithubMcpAccountSource,
  sources: GithubMcpTokenSources,
  fetchFn: FetchLike,
  options: { pastedToken?: string; signal?: AbortSignal } = {},
): Promise<{ check: GithubMcpAccountCheck; token?: string }> {
  const read = await readGithubMcpToken(source, sources, options.pastedToken);
  if (!read.ok) return { check: { source, state: read.state } };
  return {
    check: await describeGithubMcpToken(source, read.token, fetchFn, options.signal),
    token: read.token,
  };
}

/**
 * The fetch a hosted GitHub session sends through. The token and GitHub's
 * configuration headers go only to GitHub's MCP origin; a request anywhere
 * else is passed on bare, and `fetchFn` (the gateway's safe fetch) strips
 * credentials from a cross-origin redirect as well.
 */
export function githubMcpHostedFetch(
  fetchFn: FetchLike,
  token: string,
  settings: Pick<GithubMcpSettings, "toolsets" | "readOnly" | "skills">,
): FetchLike {
  const origin = new URL(GITHUB_MCP_HOSTED_URL).origin;
  const extra = githubMcpHostedHeaders(settings);
  return async (input, init) => {
    if (new URL(input).origin !== origin) return await fetchFn(input, init);
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    headers.set("authorization", `Bearer ${token}`);
    return await fetchFn(input, { ...init, headers });
  };
}

type CachedCheck = { check: GithubMcpAccountCheck; at: number; key: string };

/**
 * The account each GitHub row shows, read at most once a minute.
 *
 * Settings lists connections on every window focus; asking `gh` and GitHub
 * each time would spend a subprocess and a request on a line of text. This
 * cache feeds only that line. A connect never reads it: it asks the source
 * again, so a signed-out `gh` stops threads at their next connect.
 */
export class GithubMcpAccountStatusCache {
  private readonly entries = new Map<string, CachedCheck>();
  private readonly pending = new Map<string, Promise<GithubMcpAccountCheck>>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  cached(connectionId: string, key: string): GithubMcpAccountCheck | undefined {
    const entry = this.entries.get(connectionId);
    return entry && entry.key === key && this.now() - entry.at < this.ttlMs ? entry.check : undefined;
  }

  async read(
    connectionId: string,
    key: string,
    check: () => Promise<GithubMcpAccountCheck>,
  ): Promise<GithubMcpAccountCheck> {
    const cached = this.cached(connectionId, key);
    if (cached) return cached;
    const pendingKey = `${connectionId}\u0000${key}`;
    const inFlight = this.pending.get(pendingKey);
    if (inFlight) return await inFlight;
    const read = check().then((result) => {
      this.entries.set(connectionId, { check: result, at: this.now(), key });
      return result;
    }).finally(() => this.pending.delete(pendingKey));
    this.pending.set(pendingKey, read);
    return await read;
  }

  /** Record a fresh answer, such as a Settings test's. */
  remember(connectionId: string, key: string, check: GithubMcpAccountCheck): void {
    this.entries.set(connectionId, { check, at: this.now(), key });
  }

  forget(connectionId: string): void {
    this.entries.delete(connectionId);
  }
}
