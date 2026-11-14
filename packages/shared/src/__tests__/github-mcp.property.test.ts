import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GITHUB_MCP_DEFAULT_TOOLSETS,
  GITHUB_MCP_TOOLSETS,
  defaultGithubMcpSettingsInput,
  expandGithubScopes,
  githubMcpHostedHeaders,
  githubMcpLocalArgs,
  isGithubMcpServerUrl,
  missingGithubMcpScopes,
  normalizeGithubMcpToolsets,
  type GithubMcpToolset,
} from "../github-mcp";

const toolset = fc.constantFrom(...GITHUB_MCP_TOOLSETS);
const toolsets = fc.uniqueArray(toolset, { minLength: 1 }).map(normalizeGithubMcpToolsets);
const settings = fc.record({ toolsets, readOnly: fc.boolean(), skills: fc.boolean() });
const SCOPES = [
  "repo", "public_repo", "repo:status", "security_events", "notifications", "project", "read:project",
  "gist", "read:org", "write:org", "admin:org", "workflow", "read:discussion", "write:discussion", "user",
];
const scopes = fc.uniqueArray(fc.constantFrom(...SCOPES));

/**
 * The hosted server's own reading of its headers, as `docs/remote-server.md`
 * states it: toolsets are a comma-separated list, and read-only is false for
 * an empty value, "false", "f", "no", "n", "0" or "off", true otherwise.
 * Feature flags are a comma-separated list (`docs/feature-flags.md`).
 */
function hostedReading(headers: Record<string, string>) {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const readOnlyValue = (lower.get("x-mcp-readonly") ?? "").trim().toLowerCase();
  return {
    toolsets: (lower.get("x-mcp-toolsets") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    readOnly: !["", "false", "f", "no", "n", "0", "off"].includes(readOnlyValue),
    skills: (lower.get("x-mcp-features") ?? "").split(",").map((item) => item.trim()).includes("skills"),
  };
}

/** `github-mcp-server`'s flag reading (cobra/pflag), for the flags we pass. */
function localReading(args: string[]) {
  expect(args[0]).toBe("stdio");
  let toolsetList: string[] = [];
  let readOnly = false;
  let features: string[] = [];
  for (const arg of args.slice(1)) {
    const [flag, value] = arg.split(/=(.*)/s, 2) as [string, string | undefined];
    if (flag === "--toolsets") toolsetList = (value ?? "").split(",").filter(Boolean);
    else if (flag === "--read-only") readOnly = value === undefined || value === "true";
    else if (flag === "--features") features = (value ?? "").split(",").filter(Boolean);
    else throw new Error(`unexpected argument ${arg}`);
  }
  return { toolsets: toolsetList, readOnly, skills: features.includes("skills") };
}

describe("GitHub MCP settings", () => {
  it("normalizes toolsets to known names, once each, in catalog order", () => {
    fc.assert(fc.property(fc.array(fc.oneof(toolset, fc.string())), (values) => {
      const once = normalizeGithubMcpToolsets(values);
      expect(normalizeGithubMcpToolsets(once)).toEqual(once);
      expect(new Set(once).size).toBe(once.length);
      expect(once.every((name) => values.includes(name))).toBe(true);
      expect(values.filter((value): value is GithubMcpToolset =>
        (GITHUB_MCP_TOOLSETS as readonly string[]).includes(value)).every((name) => once.includes(name))).toBe(true);
      const positions = once.map((name) => GITHUB_MCP_TOOLSETS.indexOf(name));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }));
  });

  it("starts with GitHub's defaults minus the toolsets PwrAgent covers, skills on", () => {
    const input = defaultGithubMcpSettingsInput();
    expect(input.toolsets).toEqual(["context", "repos", "issues", "users"]);
    expect(input.toolsets).not.toContain("pull_requests");
    expect(input.toolsets).not.toContain("actions");
    expect(input).toMatchObject({ account: "gh_cli", server: "hosted", readOnly: false, skills: true });
    expect(GITHUB_MCP_DEFAULT_TOOLSETS).toEqual(input.toolsets);
  });

  it("says to the hosted server exactly what the settings say", () => {
    fc.assert(fc.property(settings, (value) => {
      expect(hostedReading(githubMcpHostedHeaders(value))).toEqual(value);
    }));
  });

  it("says to the local server exactly what the settings say", () => {
    fc.assert(fc.property(settings, (value) => {
      expect(localReading(githubMcpLocalArgs(value))).toEqual(value);
    }));
  });
});

describe("missing GitHub scopes", () => {
  it("claims nothing when GitHub reported no scopes", () => {
    fc.assert(fc.property(toolsets, fc.boolean(), (chosen, readOnly) => {
      expect(missingGithubMcpScopes({ toolsets: chosen, readOnly, scopes: undefined }))
        .toEqual({ toolsets: [], scopes: [] });
    }));
  });

  it("never reports a scope the login already covers, and adding what it reports clears it", () => {
    fc.assert(fc.property(toolsets, fc.boolean(), scopes, (chosen, readOnly, granted) => {
      const missing = missingGithubMcpScopes({ toolsets: chosen, readOnly, scopes: granted });
      const covered = expandGithubScopes(granted);
      expect(missing.scopes.some((scope) => covered.has(scope))).toBe(false);
      expect(missing.toolsets.every((name) => chosen.includes(name))).toBe(true);
      expect(missingGithubMcpScopes({ toolsets: chosen, readOnly, scopes: [...granted, ...missing.scopes] }))
        .toEqual({ toolsets: [], scopes: [] });
    }));
  });

  it("never needs more when the login gains a scope", () => {
    fc.assert(fc.property(toolsets, fc.boolean(), scopes, fc.constantFrom(...SCOPES), (chosen, readOnly, granted, extra) => {
      const before = missingGithubMcpScopes({ toolsets: chosen, readOnly, scopes: granted });
      const after = missingGithubMcpScopes({ toolsets: chosen, readOnly, scopes: [...granted, extra] });
      expect(after.toolsets.every((name) => before.toolsets.includes(name))).toBe(true);
    }));
  });

  it("finds only projects missing from gh's default login", () => {
    // gh auth login asks for repo, read:org, workflow and gist.
    expect(missingGithubMcpScopes({
      toolsets: ["context", "repos", "issues", "users", "notifications", "projects", "gists"],
      readOnly: false,
      scopes: ["gist", "read:org", "repo", "workflow"],
    })).toEqual({ toolsets: ["projects"], scopes: ["project"] });
    expect(missingGithubMcpScopes({ toolsets: ["projects"], readOnly: true, scopes: ["repo"] }).scopes)
      .toEqual(["read:project"]);
  });
});

/** The runtime's WHATWG URL parser; this package's own types declare no DOM. */
const PlatformUrl = (globalThis as unknown as { URL: new (value: string) => { hostname: string } }).URL;

describe("isGithubMcpServerUrl", () => {
  const hosts = fc.oneof(
    fc.constant("api.githubcopilot.com"),
    fc.constant("API.GitHubCopilot.com"),
    fc.constant("api.githubcopilot.com.evil.example"),
    fc.constant("githubcopilot.com"),
    fc.constant("evil.example"),
    fc.domain(),
  );
  const paths = fc.constantFrom("", "/", "/mcp/", "/mcp", "/mcp/readonly", "/mcp/x/repos", "?a=1", "#frag");

  it("agrees with the platform URL parser on whose host it is", () => {
    fc.assert(fc.property(
      fc.constantFrom("https://", "http://", ""),
      fc.constantFrom("", "user@", "user:pw@"),
      hosts,
      fc.constantFrom("", ":443", ":8443"),
      paths,
      (scheme, userInfo, host, port, rest) => {
        const typed = `${scheme}${userInfo}${host}${port}${rest}`;
        const oracle = new PlatformUrl(scheme ? typed : `https://${typed}`).hostname === "api.githubcopilot.com";
        expect(isGithubMcpServerUrl(typed)).toBe(oracle);
      },
    ));
  });

  it("is not fooled by a lookalike path or query", () => {
    expect(isGithubMcpServerUrl("https://evil.example/api.githubcopilot.com/mcp/")).toBe(false);
    expect(isGithubMcpServerUrl("https://evil.example/?u=https://api.githubcopilot.com/mcp/")).toBe(false);
    expect(isGithubMcpServerUrl("https://api.githubcopilot.com@evil.example/mcp/")).toBe(false);
    expect(isGithubMcpServerUrl("  api.githubcopilot.com/mcp/  ")).toBe(true);
  });
});
