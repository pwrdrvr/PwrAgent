import { sandboxerStub } from "./helpers/sandboxer-stub";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpConnectionsForPeer, resolveMcpConnectionSetup } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { McpStdioSecretVault } from "../mcp-connections/mcp-stdio-secret-vault";
import { probeMcpConnectionUrl } from "../mcp-connections/mcp-connection-probe";

/*
 * GitHub's MCP server through the gateway, end to end, against fakes:
 * `api.github.com/user` and the hosted MCP endpoint answer through an
 * injected fetch, the GitHub CLI is a pair of injected functions, and the
 * local server is a small Node script named `github-mcp-server` that records
 * the argv and token it was started with. Nothing reaches GitHub or runs gh.
 */
const FAKE_LOCAL_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(__dirname);
fs.writeFileSync(path.join(dir, "local-start.json"), JSON.stringify({
  argv: process.argv.slice(2),
  token: process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? null,
  inherited: process.env.GITHUB_TOOLSETS ?? null,
}));
if (fs.existsSync(path.join(dir, "fail"))) {
  process.stderr.write("bad credentials for " + process.env.GITHUB_PERSONAL_ACCESS_TOKEN + "\n");
  process.exit(1);
}
const skills = process.argv.includes("--features=skills");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
function handle(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {}, resources: {}, ...(skills ? { extensions: { "io.modelcontextprotocol/skills": {} } } : {}) },
      serverInfo: { name: "github-mcp-server", version: "1.2.0" },
    } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "get_me", inputSchema: { type: "object", properties: {} } },
      { name: "search_repositories", inputSchema: { type: "object", properties: {} } },
      { name: "list_issues", inputSchema: { type: "object", properties: {} } },
    ] } });
  } else if (message.method === "skills/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { skills: [
      { uri: "skill://github.com/issue-authoring/SKILL.md", frontmatter: { name: "issue-authoring" } },
      { uri: "skill://github.com/repository-discovery/SKILL.md", frontmatter: { name: "repository-discovery" } },
    ] } });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
  }
}
`;

type Fixture = { root: string; binDir: string };
type HostedRequest = { method: string; rpc?: string; headers: Headers };

const services: McpConnectionGatewayService[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-github-"));
  temporaryDirectories.push(root);
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "github-mcp-server"), FAKE_LOCAL_SERVER, { mode: 0o755 });
  return { root, binDir };
}

/** github.com's accounts: token → login and classic scopes. */
const ACCOUNTS: Record<string, { login: string; scopes: string }> = {
  gho_first0000: { login: "octo-dev", scopes: "repo, read:org, workflow, gist" },
  gho_second000: { login: "octo-second", scopes: "repo" },
  github_pat_narrow: { login: "octo-bot", scopes: "" },
};

/** A fake api.github.com and api.githubcopilot.com, recording each MCP request. */
function fakeGithub() {
  const hosted: HostedRequest[] = [];
  const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const account = ACCOUNTS[bearer];
    if (url.href === "https://api.github.com/user") {
      if (!account) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      return new Response(JSON.stringify({ login: account.login }), {
        headers: { "content-type": "application/json", "x-oauth-scopes": account.scopes },
      });
    }
    if (url.origin !== "https://api.githubcopilot.com") throw new Error(`unexpected request to ${url.href}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { id?: number; method?: string } : undefined;
    hosted.push({ method, ...(body?.method ? { rpc: body.method } : {}), headers });
    if (!account) return new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    if (body?.id === undefined) return new Response(null, { status: 202 });
    const json = (result: unknown, extra: Record<string, string> = {}) => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      { headers: { "content-type": "application/json", ...extra } },
    );
    if (body.method === "initialize") {
      return json({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "github-mcp-server", version: "remote" },
        instructions: "GitHub's own instructions.",
      }, { "mcp-session-id": "session-1" });
    }
    if (body.method === "tools/list") {
      const toolsets = headers.get("x-mcp-toolsets")?.split(",") ?? [];
      return json({ tools: toolsets.map((name) => ({ name: `${name}_tool`, inputSchema: { type: "object" } })) });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unsupported" } }), {
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchFn, hosted };
}

function createService(fixture: Fixture, cli: { installed: boolean; token: string | null }) {
  const github = fakeGithub();
  const registry = new McpConnectionRegistry({ configPath: path.join(fixture.root, "config.toml") });
  let stored: string | undefined;
  const secretSettings = {
    resolveMcpStdioConnectionSecrets: vi.fn(async () => stored),
    saveMcpStdioConnectionSecrets: vi.fn(async (value: string) => {
      stored = value;
    }),
    clearMcpStdioConnectionSecrets: vi.fn(async () => {
      stored = undefined;
    }),
  };
  const readGhToken = vi.fn(async () => {
    if (cli.token === null) throw new Error("GitHub CLI authentication status check failed");
    return cli.token;
  });
  const service = new McpConnectionGatewayService({
    sandboxer: sandboxerStub(),
    bridgeEntryPath: "/test/mcp-connection-bridge.js",
    gatewayEnabled: () => true,
    leaseManager: null,
    registry,
    fetchFn: github.fetchFn as unknown as typeof fetch,
    settings: {
      clearMcpConnectionCredentials: vi.fn(async () => undefined),
      clearPwrSnapMcpCredential: vi.fn(async () => undefined),
      clearPwrGitMcpCredential: vi.fn(async () => undefined),
      resolveMcpConnectionCredentials: vi.fn(async () => undefined),
      resolvePwrSnapMcpCredential: vi.fn(async () => undefined),
      resolvePwrGitMcpCredential: vi.fn(async () => undefined),
      saveMcpConnectionCredentials: vi.fn(async () => undefined),
      savePwrSnapMcpCredential: vi.fn(async () => undefined),
    },
    resolveStdioSearchEnv: async () => ({ PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}` }),
    stdioSecrets: new McpStdioSecretVault({ settings: secretSettings }),
    stdioTestTimeoutMs: 3_000,
    findGh: async () => cli.installed ? "/opt/homebrew/bin/gh" : undefined,
    readGhToken,
  });
  services.push(service);
  return { service, registry, github, readGhToken, stored: () => stored, secretSettings };
}

const DEFAULTS = { toolsets: ["context", "repos", "issues", "users"], readOnly: false, skills: true };

describe("GitHub MCP connections", () => {
  it("signs in with the GitHub CLI on every connect and never stores its token", async () => {
    const fixture = makeFixture();
    const cli = { installed: true, token: "gho_first0000" as string | null };
    const { service, registry, github, readGhToken, secretSettings } = createService(fixture, cli);

    const created = await service.createConnection({
      displayName: "GitHub",
      github: { account: "gh_cli", server: "hosted", ...DEFAULTS },
    });
    expect(created).toMatchObject({
      kind: "github",
      configured: true,
      githubAccount: { source: "gh_cli", state: "ready", login: "octo-dev", scopes: ["repo", "read:org", "workflow", "gist"] },
    });
    expect(secretSettings.saveMcpStdioConnectionSecrets).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(fixture.root, "config.toml"), "utf8")).not.toContain("gho_");
    expect(resolveMcpConnectionSetup({ connection: created, gatewayEnabled: true })).toMatchObject({
      state: "ready",
      detail: "Acts as @octo-dev through your GitHub CLI sign-in. Toolsets: context, repos, issues, users.",
    });

    const first = await service.listConnectionTools({ connectionId: created.id });
    expect(first.tools).toEqual(["context_tool", "repos_tool", "issues_tool", "users_tool"]);
    const initialize = github.hosted.find((request) => request.rpc === "initialize")!;
    expect(initialize.headers.get("authorization")).toBe("Bearer gho_first0000");
    expect(initialize.headers.get("x-mcp-toolsets")).toBe("context,repos,issues,users");
    expect(initialize.headers.get("x-mcp-features")).toBe("skills");
    expect(initialize.headers.get("x-mcp-readonly")).toBeNull();

    // gh switched accounts: the next connect uses the new login.
    cli.token = "gho_second000";
    github.hosted.length = 0;
    const callsBefore = readGhToken.mock.calls.length;
    await service.listConnectionTools({ connectionId: created.id, refresh: true });
    expect(readGhToken.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(github.hosted.find((request) => request.rpc === "initialize")!.headers.get("authorization"))
      .toBe("Bearer gho_second000");

    // gh signed out: the connect stops with the fix, and the row says so.
    cli.token = null;
    await expect(service.listConnectionTools({ connectionId: created.id, refresh: true }))
      .rejects.toThrow(/not signed in to github\.com\. Run gh auth login/);
    const [row] = (await service.listConnections()).filter((connection) => connection.id === created.id);
    expect(row).toMatchObject({ configured: false, githubAccount: { state: "signed_out" } });
    expect(resolveMcpConnectionSetup({ connection: row!, gatewayEnabled: true })).toMatchObject({
      state: "login_required",
      headline: "GitHub CLI signed out",
    });
    expect(registry.get(created.id)?.github?.account).toBe("gh_cli");

    // A peer sees the connection but not whose account it is.
    expect(mcpConnectionsForPeer([row!])[0]).not.toHaveProperty("githubAccount");
  });

  it("stores a pasted token encrypted, tests it, and deletes it when the account moves to the CLI", async () => {
    const fixture = makeFixture();
    const { service, stored, github } = createService(fixture, { installed: false, token: null });

    await expect(service.createConnection({
      displayName: "GitHub bot",
      github: { account: "token", server: "hosted", ...DEFAULTS },
    })).rejects.toThrow(/Paste a personal access token/);

    const rejected = await service.testGithubConnection({
      github: { account: "token", server: "hosted", ...DEFAULTS, token: "gho_revoked00" },
    });
    expect(rejected).toEqual({
      ok: false,
      problem: "account",
      message: "GitHub rejected the token (401). It may have expired or been revoked. Paste a new one.",
      account: { source: "token", state: "rejected" },
    });

    const passed = await service.testGithubConnection({
      github: { account: "token", server: "hosted", ...DEFAULTS, readOnly: true, token: " github_pat_narrow " },
    });
    expect(passed).toMatchObject({ ok: true, toolCount: 4, account: { login: "octo-bot", scopes: [] } });
    expect(passed.ok && passed.skillCount).toBeFalsy();
    expect(github.hosted.at(-1)!.headers.get("x-mcp-readonly")).toBe("true");

    const created = await service.createConnection({
      displayName: "GitHub bot",
      github: { account: "token", server: "hosted", ...DEFAULTS, token: "github_pat_narrow" },
    });
    expect(created).toMatchObject({ configured: true, githubAccount: { login: "octo-bot" } });
    expect(stored()).toContain("github_pat_narrow");
    expect(JSON.stringify(await service.listConnections())).not.toContain("github_pat_narrow");

    // An edit that leaves the token blank keeps it.
    await service.updateConnection({
      connectionId: created.id,
      github: { account: "token", server: "hosted", toolsets: ["repos"], readOnly: false, skills: false },
    });
    expect(stored()).toContain("github_pat_narrow");

    await service.updateConnection({
      connectionId: created.id,
      github: { account: "gh_cli", server: "hosted", ...DEFAULTS },
    });
    expect(stored() ?? "").not.toContain("github_pat_narrow");
    const [row] = await service.listConnections().then((rows) => rows.filter((item) => item.id === created.id));
    expect(row).toMatchObject({ configured: false, githubAccount: { source: "gh_cli", state: "gh_missing" } });
  });

  // The fake server is a `#!/usr/bin/env node` script, which Windows cannot
  // execute directly; the local command suite skips Windows the same way.
  it.skipIf(process.platform === "win32")("starts the local server with GitHub's flags and the token as its one secret", async () => {
    const fixture = makeFixture();
    const { service } = createService(fixture, { installed: true, token: "gho_first0000" });

    expect(await service.inspectGithubSetup()).toEqual({
      cli: { source: "gh_cli", state: "ready", login: "octo-dev", scopes: ["repo", "read:org", "workflow", "gist"] },
      localCommand: path.join(fixture.binDir, "github-mcp-server"),
    });

    const passed = await service.testGithubConnection({
      github: { account: "gh_cli", server: "local", toolsets: ["repos", "issues"], readOnly: true, skills: true },
    });
    expect(passed).toMatchObject({
      ok: true,
      command: path.join(fixture.binDir, "github-mcp-server"),
      serverVersion: "1.2.0",
      toolCount: 3,
      skillCount: 2,
    });
    expect(JSON.parse(fs.readFileSync(path.join(fixture.root, "local-start.json"), "utf8"))).toEqual({
      argv: ["stdio", "--toolsets=repos,issues", "--read-only", "--features=skills"],
      token: "gho_first0000",
      inherited: null,
    });

    // A server that fails prints the token; the operator sees it masked.
    fs.writeFileSync(path.join(fixture.root, "fail"), "");
    const failed = await service.testGithubConnection({
      github: { account: "gh_cli", server: "local", toolsets: ["repos"], readOnly: false, skills: false },
    });
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("gho_first0000");
    expect(!failed.ok && failed.output).toMatch(/bad credentials for/);

    fs.rmSync(path.join(fixture.binDir, "github-mcp-server"));
    expect(await service.testGithubConnection({
      github: { account: "gh_cli", server: "local", toolsets: ["repos"], readOnly: false, skills: false },
    })).toMatchObject({ ok: false, problem: "not_found" });
  });

  it("refuses an empty toolset list, which GitHub would read as its defaults", async () => {
    const fixture = makeFixture();
    const { service } = createService(fixture, { installed: true, token: "gho_first0000" });
    expect(await service.testGithubConnection({
      github: { account: "gh_cli", server: "hosted", toolsets: ["not-a-toolset"], readOnly: false, skills: true },
    })).toEqual({ ok: false, problem: "invalid", message: "Choose at least one toolset." });
  });
});

describe("probeMcpConnectionUrl for GitHub", () => {
  it("names GitHub's server before any OAuth discovery runs", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 500 }));
    for (const typed of ["https://api.githubcopilot.com/mcp/", "api.githubcopilot.com/mcp/x/repos"]) {
      expect(await probeMcpConnectionUrl(typed, fetchFn as unknown as typeof fetch)).toMatchObject({
        ok: false,
        problem: "github_server",
      });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
