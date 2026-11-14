import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { GithubMcpAccountSource } from "@pwragent/shared";
import {
  GithubMcpAccountStatusCache,
  GITHUB_API_USER_URL,
  checkGithubMcpAccount,
  githubMcpHostedFetch,
  parseGithubScopesHeader,
  readGithubMcpToken,
  type GithubMcpTokenSources,
} from "../mcp-connections/github-mcp-account";

/**
 * The token-source state machine, against a model of the world it reads.
 *
 * The world: whether `gh` is installed, the token it is signed in with (or
 * none), and the token stored for the connection (or none, or unreadable).
 * The rule a GitHub connection owes the operator: every connect reads the
 * source as it is now. A `gh auth login` as someone else, a `gh auth
 * logout`, or a pasted replacement applies to the very next connect, and a
 * connect after a logout stops rather than reusing the last token.
 */
type World = {
  ghInstalled: boolean;
  ghToken: string | null;
  stored: string | undefined | "unreadable";
};

const token = fc.stringMatching(/^gh[op]_[A-Za-z0-9]{8,20}$/);

/** What one connect must get, read straight off the model. */
function expected(world: World, source: GithubMcpAccountSource) {
  if (source === "token") {
    if (world.stored === "unreadable" || !world.stored) return { ok: false, state: "token_missing" } as const;
    return { ok: true, token: world.stored } as const;
  }
  if (!world.ghInstalled) return { ok: false, state: "gh_missing" } as const;
  if (!world.ghToken) return { ok: false, state: "signed_out" } as const;
  return { ok: true, token: world.ghToken } as const;
}

function sourcesFor(world: World, calls: { gh: number }): GithubMcpTokenSources {
  return {
    findGh: async () => world.ghInstalled ? "/opt/homebrew/bin/gh" : undefined,
    readGhToken: async () => {
      calls.gh += 1;
      // A signed-out gh exits non-zero; readGithubAuthToken throws then.
      if (world.ghToken === null) throw new Error(`no oauth token found for github.com`);
      return `${world.ghToken}\n`;
    },
    readStoredToken: async () => {
      if (world.stored === "unreadable") throw new Error("decrypt failed");
      return world.stored;
    },
  };
}

type Command =
  | { kind: "install"; installed: boolean }
  | { kind: "login"; token: string }
  | { kind: "logout" }
  | { kind: "store"; token: string | undefined | "unreadable" }
  | { kind: "connect"; source: GithubMcpAccountSource };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.boolean().map((installed) => ({ kind: "install", installed }) as const),
  token.map((value) => ({ kind: "login", token: value }) as const),
  fc.constant({ kind: "logout" } as const),
  fc.oneof(token, fc.constant(undefined), fc.constant("unreadable" as const))
    .map((value) => ({ kind: "store", token: value }) as const),
  fc.constantFrom<GithubMcpAccountSource>("gh_cli", "token").map((source) => ({ kind: "connect", source }) as const),
);

describe("GitHub MCP token sources", () => {
  it("reads the source fresh on every connect, whatever happened in between", async () => {
    await fc.assert(fc.asyncProperty(fc.array(command, { maxLength: 40 }), async (commands) => {
      const world: World = { ghInstalled: true, ghToken: "gho_initial0", stored: undefined };
      const calls = { gh: 0 };
      const sources = sourcesFor(world, calls);
      for (const step of commands) {
        if (step.kind === "install") world.ghInstalled = step.installed;
        else if (step.kind === "login") world.ghToken = step.token;
        else if (step.kind === "logout") world.ghToken = null;
        else if (step.kind === "store") world.stored = step.token;
        else {
          const before = calls.gh;
          const read = await readGithubMcpToken(step.source, sources);
          expect(read).toEqual(expected(world, step.source));
          // The CLI source asks gh each time it is installed; the token
          // source never runs gh.
          expect(calls.gh - before).toBe(step.source === "gh_cli" && world.ghInstalled ? 1 : 0);
        }
      }
    }), { numRuns: 300 });
  });

  it("prefers a pasted token over the stored one, and never runs gh for it", async () => {
    await fc.assert(fc.asyncProperty(token, fc.option(token, { nil: undefined }), async (pasted, stored) => {
      const world: World = { ghInstalled: true, ghToken: "gho_other000", stored };
      const calls = { gh: 0 };
      expect(await readGithubMcpToken("token", sourcesFor(world, calls), pasted)).toEqual({ ok: true, token: pasted });
      expect(calls.gh).toBe(0);
    }));
  });

  it("never puts the token in what a check reports, whatever GitHub answers", async () => {
    const answer = fc.record({
      status: fc.constantFrom(200, 200, 401, 403, 500),
      login: fc.oneof(fc.stringMatching(/^[A-Za-z0-9-]{1,20}$/), fc.string()),
      scopes: fc.option(fc.string(), { nil: null }),
      network: fc.boolean(),
    });
    await fc.assert(fc.asyncProperty(
      token, answer, fc.constantFrom<GithubMcpAccountSource>("gh_cli", "token"),
      async (secret, reply, source) => {
        const world: World = { ghInstalled: true, ghToken: secret, stored: secret };
        const seen: string[] = [];
        const fetchFn = async (input: string | URL, init?: RequestInit) => {
          seen.push(String(input));
          expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
          if (reply.network) throw new Error(`connect ECONNREFUSED while sending ${secret}`);
          // A hostile body that echoes the token back must not reach the result.
          return new Response(JSON.stringify({ login: reply.login, echo: secret }), {
            status: reply.status,
            headers: reply.scopes === null ? {} : { "x-oauth-scopes": reply.scopes },
          });
        };
        const { check, token: read } = await checkGithubMcpAccount(source, sourcesFor(world, { gh: 0 }), fetchFn);
        expect(read).toBe(secret);
        expect(JSON.stringify(check)).not.toContain(secret);
        expect(seen).toEqual([GITHUB_API_USER_URL]);
        const state = reply.network ? "unreachable"
          : reply.status === 401 ? "rejected"
          : reply.status === 200 ? "ready"
          : "unreachable";
        expect(check.state).toBe(state);
        expect(check.source).toBe(source);
      },
    ));
  });

  it("reads classic scopes, and none when GitHub sends no header", () => {
    expect(parseGithubScopesHeader(null)).toBeUndefined();
    expect(parseGithubScopesHeader("")).toEqual([]);
    expect(parseGithubScopesHeader("repo, read:org,gist , repo")).toEqual(["repo", "read:org", "gist"]);
    expect(parseGithubScopesHeader("repo, <script>")).toEqual(["repo"]);
  });
});

describe("githubMcpHostedFetch", () => {
  it("sends the token and GitHub's headers to GitHub's MCP origin only", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("{}");
    };
    const send = githubMcpHostedFetch(fetchFn, "gho_secret123", {
      toolsets: ["context", "repos"],
      readOnly: true,
      skills: true,
    });
    await send(new URL("https://api.githubcopilot.com/mcp/"), { headers: { accept: "application/json" } });
    await send(new URL("https://elsewhere.example/mcp/"), { headers: { accept: "application/json" } });
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer gho_secret123");
    expect(requests[0]!.headers.get("x-mcp-toolsets")).toBe("context,repos");
    expect(requests[0]!.headers.get("x-mcp-readonly")).toBe("true");
    expect(requests[0]!.headers.get("x-mcp-features")).toBe("skills");
    expect(requests[0]!.headers.get("accept")).toBe("application/json");
    expect(requests[1]!.headers.get("authorization")).toBeNull();
    expect(requests[1]!.headers.get("x-mcp-toolsets")).toBeNull();
  });
});

describe("GithubMcpAccountStatusCache", () => {
  it("serves a fresh answer for a minute, per source, and runs one check at a time", async () => {
    let now = 0;
    const cache = new GithubMcpAccountStatusCache(60_000, () => now);
    let checks = 0;
    const check = async () => {
      checks += 1;
      return { source: "gh_cli" as const, state: "ready" as const, login: `user${checks}` };
    };
    const [first, second] = await Promise.all([cache.read("github", "gh_cli", check), cache.read("github", "gh_cli", check)]);
    expect(first).toEqual(second);
    expect(checks).toBe(1);
    now = 59_999;
    expect((await cache.read("github", "gh_cli", check)).login).toBe("user1");
    expect(cache.cached("github", "token")).toBeUndefined();
    now = 60_000;
    expect((await cache.read("github", "gh_cli", check)).login).toBe("user2");
    cache.forget("github");
    expect(cache.cached("github", "gh_cli")).toBeUndefined();
  });
});
