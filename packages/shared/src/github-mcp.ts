/**
 * GitHub's MCP server as a PwrAgent-managed connection.
 *
 * Neither of the general paths can reach it without hand setup. GitHub's
 * hosted server names `github.com/login/oauth` as its sign-in server, which
 * has no dynamic client registration, and a Server URL connection cannot send
 * a fixed bearer header. So a GitHub connection holds its own account source
 * (the GitHub CLI sign-in, read on each connect, or a stored token) and its
 * own server choice (GitHub-hosted, or `github-mcp-server stdio` on this
 * computer), and this module turns those into GitHub's documented headers and
 * flags.
 *
 * Header and flag names follow github/github-mcp-server:
 * `docs/remote-server.md`, `docs/feature-flags.md` and
 * `cmd/github-mcp-server/main.go`.
 */

export const GITHUB_MCP_HOSTED_URL = "https://api.githubcopilot.com/mcp/";
export const GITHUB_MCP_HOSTED_HOST = "api.githubcopilot.com";
/** The program the local server option runs, resolved on the login PATH. */
export const GITHUB_MCP_LOCAL_PROGRAM = "github-mcp-server";
/** The variable `github-mcp-server stdio` reads its token from. */
export const GITHUB_MCP_TOKEN_ENV = "GITHUB_PERSONAL_ACCESS_TOKEN";

/** Whose access a GitHub connection uses. */
export type GithubMcpAccountSource = "gh_cli" | "token";
/** Where its server runs. */
export type GithubMcpServerLocation = "hosted" | "local";

export function isGithubMcpAccountSource(value: unknown): value is GithubMcpAccountSource {
  return value === "gh_cli" || value === "token";
}

export function isGithubMcpServerLocation(value: unknown): value is GithubMcpServerLocation {
  return value === "hosted" || value === "local";
}

/**
 * Every toolset the form offers, in the order it shows them. The first ten
 * are always visible; the rest sit behind "More toolsets".
 */
export const GITHUB_MCP_TOOLSETS = [
  "context",
  "repos",
  "issues",
  "users",
  "discussions",
  "notifications",
  "projects",
  "pull_requests",
  "actions",
  "code_security",
  "gists",
  "labels",
  "git",
  "orgs",
  "stargazers",
  "code_quality",
  "dependabot",
  "secret_protection",
  "security_advisories",
  "copilot",
  "copilot_issue_intents",
  "governance",
] as const;

export type GithubMcpToolset = (typeof GITHUB_MCP_TOOLSETS)[number];

/** How many toolsets the form shows before "More toolsets". */
export const GITHUB_MCP_PRIMARY_TOOLSET_COUNT = 10;

/**
 * Toolsets PwrAgent's own forge tools already cover. Their own tools keep the
 * PR chips, watches and Continue After in sync, so GitHub's copies start off.
 */
export const GITHUB_MCP_BUILT_IN_OVERLAP_TOOLSETS: readonly GithubMcpToolset[] = [
  "pull_requests",
  "actions",
];

/**
 * GitHub's own default set (context, repos, issues, pull_requests, users)
 * without the toolsets PwrAgent already covers.
 */
export const GITHUB_MCP_DEFAULT_TOOLSETS: readonly GithubMcpToolset[] = [
  "context",
  "repos",
  "issues",
  "users",
];

export function isGithubMcpToolset(value: unknown): value is GithubMcpToolset {
  return GITHUB_MCP_TOOLSETS.some((toolset) => toolset === value);
}

/**
 * Known toolsets only, each once, in catalog order. GitHub ignores a name it
 * does not know, so keeping one would only make the row claim a toolset
 * nobody gets.
 */
export function normalizeGithubMcpToolsets(values: unknown): GithubMcpToolset[] {
  if (!Array.isArray(values)) return [];
  const chosen = new Set(values.filter(isGithubMcpToolset));
  return GITHUB_MCP_TOOLSETS.filter((toolset) => chosen.has(toolset));
}

/** A GitHub connection as stored. */
export type GithubMcpSettings = {
  account: GithubMcpAccountSource;
  server: GithubMcpServerLocation;
  /**
   * The absolute path of `github-mcp-server`, for the local server only.
   * Absent on a federation peer's copy: it describes the owner's machine.
   */
  command?: string;
  /** Never empty: GitHub reads an empty list as its own defaults. */
  toolsets: GithubMcpToolset[];
  readOnly: boolean;
  skills: boolean;
};

/** A GitHub connection as the Settings form submits it. */
export type GithubMcpSettingsInput = {
  account: GithubMcpAccountSource;
  server: GithubMcpServerLocation;
  /**
   * The local server's program, a name looked up on the login PATH or a full
   * path. Absent uses `github-mcp-server`.
   */
  command?: string;
  toolsets: string[];
  readOnly: boolean;
  skills: boolean;
  /**
   * A personal access token, for the token account only. On an edit,
   * omitting it keeps the stored one, so the window never reads it back.
   */
  token?: string;
};

export function defaultGithubMcpSettingsInput(): GithubMcpSettingsInput {
  return {
    account: "gh_cli",
    server: "hosted",
    toolsets: [...GITHUB_MCP_DEFAULT_TOOLSETS],
    readOnly: false,
    skills: true,
  };
}

/** Whether `value` is GitHub's hosted MCP address, typed with or without a scheme. */
export function isGithubMcpServerUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // No URL global in this package. The authority is what follows an
  // optional http(s) scheme, up to the first path, query or fragment; any
  // user info and port are dropped before the host is compared.
  const match = /^(?:https?:\/\/)?([^/?#\s]+)(?:[/?#]|$)/i.exec(trimmed);
  if (!match) return false;
  const host = match[1]!.slice(match[1]!.lastIndexOf("@") + 1).replace(/:\d*$/, "");
  return host.toLowerCase().replace(/\.$/, "") === GITHUB_MCP_HOSTED_HOST;
}

/**
 * The headers the hosted server reads its configuration from
 * (`docs/remote-server.md`). Skills use the feature-flag header
 * (`docs/feature-flags.md`). The token is not here: the transport adds it.
 */
export function githubMcpHostedHeaders(
  settings: Pick<GithubMcpSettings, "toolsets" | "readOnly" | "skills">,
): Record<string, string> {
  return {
    "X-MCP-Toolsets": settings.toolsets.join(","),
    ...(settings.readOnly ? { "X-MCP-Readonly": "true" } : {}),
    ...(settings.skills ? { "X-MCP-Features": "skills" } : {}),
  };
}

/** The arguments of `github-mcp-server` (`cmd/github-mcp-server/main.go`). */
export function githubMcpLocalArgs(
  settings: Pick<GithubMcpSettings, "toolsets" | "readOnly" | "skills">,
): string[] {
  return [
    "stdio",
    `--toolsets=${settings.toolsets.join(",")}`,
    ...(settings.readOnly ? ["--read-only"] : []),
    ...(settings.skills ? ["--features=skills"] : []),
  ];
}

/**
 * The classic OAuth scope each toolset's tools ask for, from the README's
 * per-tool "OAuth Challenge Scopes". `context` needs none for `get_me`.
 * Projects ask for `project` to write and `read:project` to read.
 */
function requiredScope(toolset: GithubMcpToolset, readOnly: boolean): string | undefined {
  switch (toolset) {
    case "context":
      return undefined;
    case "notifications":
      return "notifications";
    case "projects":
      return readOnly ? "read:project" : "project";
    case "gists":
      return "gist";
    case "orgs":
    case "governance":
      return "read:org";
    case "code_security":
    case "dependabot":
    case "secret_protection":
    case "security_advisories":
      return "security_events";
    default:
      return "repo";
  }
}

/**
 * Scopes a granted scope also covers, from GitHub's scope documentation.
 * `repo` covers notifications too: the notifications API accepts either.
 */
const IMPLIED_SCOPES: Readonly<Record<string, readonly string[]>> = {
  repo: ["repo:status", "repo_deployment", "public_repo", "repo:invite", "security_events", "notifications"],
  project: ["read:project"],
  "admin:org": ["write:org", "read:org"],
  "write:org": ["read:org"],
  "write:discussion": ["read:discussion"],
};

/** Every scope a set of granted scopes covers, including implied ones. */
export function expandGithubScopes(granted: readonly string[]): Set<string> {
  const covered = new Set<string>();
  const pending = granted.map((scope) => scope.trim()).filter(Boolean);
  while (pending.length > 0) {
    const scope = pending.pop()!;
    if (covered.has(scope)) continue;
    covered.add(scope);
    pending.push(...(IMPLIED_SCOPES[scope] ?? []));
  }
  return covered;
}

export type GithubMcpMissingScopes = {
  /** Selected toolsets whose scope the login lacks, in catalog order. */
  toolsets: GithubMcpToolset[];
  /** The scopes to add, each once, in the order those toolsets need them. */
  scopes: string[];
};

/**
 * What the selected toolsets need that the login lacks.
 *
 * `scopes` undefined means GitHub did not report any, which is how a
 * fine-grained token answers: PwrAgent cannot tell, so it claims nothing.
 */
export function missingGithubMcpScopes(input: {
  toolsets: readonly GithubMcpToolset[];
  readOnly: boolean;
  scopes: readonly string[] | undefined;
}): GithubMcpMissingScopes {
  if (input.scopes === undefined) return { toolsets: [], scopes: [] };
  const covered = expandGithubScopes(input.scopes);
  const toolsets: GithubMcpToolset[] = [];
  const scopes: string[] = [];
  for (const toolset of GITHUB_MCP_TOOLSETS) {
    if (!input.toolsets.includes(toolset)) continue;
    const scope = requiredScope(toolset, input.readOnly);
    if (!scope || covered.has(scope)) continue;
    toolsets.push(toolset);
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return { toolsets, scopes };
}

/**
 * Where a connection's account stands.
 *
 * - `ready`: a token was read and GitHub accepted it.
 * - `gh_missing`: no GitHub CLI on this computer.
 * - `signed_out`: the CLI is installed but has no github.com login.
 * - `token_missing`: no token is stored, or it can no longer be read back.
 * - `rejected`: GitHub answered 401 for the token.
 * - `unreachable`: a token was read, but GitHub could not be asked about it.
 *   Connecting may still work, so this does not block.
 */
export type GithubMcpAccountState =
  | "ready"
  | "gh_missing"
  | "signed_out"
  | "token_missing"
  | "rejected"
  | "unreachable";

/** What a check found. Never carries the token. */
export type GithubMcpAccountCheck = {
  source: GithubMcpAccountSource;
  state: GithubMcpAccountState;
  /** The GitHub login, when GitHub answered. */
  login?: string;
  /**
   * Classic scopes GitHub reported for the token. Absent when it reported
   * none, as for a fine-grained token.
   */
  scopes?: string[];
};

/** Whether threads can be handed this account at all. */
export function githubMcpAccountUsable(state: GithubMcpAccountState): boolean {
  return state === "ready" || state === "unreachable";
}

/** The two- or three-word chip a connection row shows for a blocking state. */
export function githubMcpAccountHeadline(check: GithubMcpAccountCheck): string {
  switch (check.state) {
    case "gh_missing":
      return "GitHub CLI missing";
    case "signed_out":
      return "GitHub CLI signed out";
    case "token_missing":
      return "Token missing";
    case "rejected":
      return check.source === "gh_cli" ? "Sign-in rejected" : "Token rejected";
    case "unreachable":
      return "Unverified";
    default:
      return "Ready";
  }
}

/** One sentence naming the fix, in the operator's terms. */
export function describeGithubMcpAccount(check: GithubMcpAccountCheck): string {
  switch (check.state) {
    case "gh_missing":
      return "PwrAgent can't find gh on this computer. Install it and run gh auth login, or use a personal access token.";
    case "signed_out":
      return "gh is installed but not signed in to github.com. Run gh auth login in a terminal, then check again.";
    case "token_missing":
      return "PwrAgent holds no readable token for this connection. Paste a personal access token.";
    case "rejected":
      return check.source === "gh_cli"
        ? "GitHub rejected the GitHub CLI sign-in (401). Run gh auth login again."
        : "GitHub rejected the token (401). It may have expired or been revoked. Paste a new one.";
    case "unreachable":
      return "PwrAgent could not ask GitHub about this account. Threads will try it when they connect.";
    default:
      return check.login ? `Signed in as @${check.login}.` : "GitHub accepted the token.";
  }
}

/**
 * Check a GitHub connection's account and server before anything is saved:
 * the GitHub CLI sign-in and whether `github-mcp-server` is installed.
 * Nothing is written, and the token never leaves the main process.
 */
export type InspectGithubMcpSetupRequest = {
  /** The local server program to look for; absent uses `github-mcp-server`. */
  command?: string;
};

export type InspectGithubMcpSetupResponse = {
  cli: GithubMcpAccountCheck;
  /** The absolute path of `github-mcp-server`, when it is installed. */
  localCommand?: string;
};

/**
 * Sign in, list the tools and skills, and disconnect, before anything is
 * saved. `connectionId` lets an edit use the stored token when the form
 * left it blank.
 */
export type TestGithubMcpConnectionRequest = {
  github: GithubMcpSettingsInput;
  connectionId?: string;
};

export type GithubMcpTestProblem =
  /** A field is malformed: no toolset chosen, no token entered. */
  | "invalid"
  /** The managed gateway is off, so PwrAgent starts no servers. */
  | "gateway_off"
  /** The account cannot be used; `account` says why. */
  | "account"
  /** `github-mcp-server` is not installed, or cannot be run. */
  | "not_found"
  /** The server started or answered, but the MCP handshake failed. */
  | "failed";

export type TestGithubMcpConnectionResponse =
  | {
      ok: true;
      account: GithubMcpAccountCheck;
      /** The local server's absolute path. Saving stores it. */
      command?: string;
      serverVersion?: string;
      toolCount: number;
      /** Absent when the server does not offer skills. */
      skillCount?: number;
      elapsedMs: number;
    }
  | {
      ok: false;
      problem: GithubMcpTestProblem;
      message: string;
      account?: GithubMcpAccountCheck;
      /** The end of a local server's own output, with the token masked. */
      output?: string;
    };
