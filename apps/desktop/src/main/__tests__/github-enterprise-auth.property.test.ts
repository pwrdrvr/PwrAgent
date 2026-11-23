import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { mergeGithubEnterpriseHosts } from "@pwragent/shared/github-enterprise-hosts";
import { parseGithubEnterpriseAuthStatus, readEnterpriseGithubToken } from "../pr-status/github-enterprise-auth";

it("merges exact saved and discovered hosts without granting discovered hosts access", () => {
  const ids = fc.uniqueArray(fc.nat(), { maxLength: 20, size: "max" });
  fc.assert(fc.property(ids, ids, (savedIds, discoveredIds) => {
    const host = (id: number) => `ghe${id}.example.com`;
    const saved = savedIds.map(host);
    const discovered = discoveredIds.map((id) => ({ host: host(id), accounts: [], activeLogin: "alice" }));
    const result = mergeGithubEnterpriseHosts(saved, discovered, URL);
    expect(new Set([...result.servers.map((row) => row.host), ...result.unused.map((row) => row.entry)])).toEqual(new Set([...saved, ...discovered.map((row) => row.host)]));
    expect(result.servers.filter((row) => row.allowed).map((row) => row.host)).toEqual(saved.slice(0, 16));
  }));
});

it("resolves only the pinned account and refuses missing pins without a fallback", async () => {
  await fc.assert(fc.asyncProperty(fc.nat(), fc.boolean(), async (id, exists) => {
    const host = `ghe${id}.example.com`;
    const login = `user-${id}`;
    const run = vi.fn(async () => exists ? "fixture-token" : Promise.reject(new Error("not signed in")));
    const env = { GH_HOST: host, GH_ENTERPRISE_TOKEN: "another-account" };
    expect(await readEnterpriseGithubToken("gh", host, login, env, run)).toBe(exists ? "fixture-token" : null);
    expect(run).toHaveBeenCalledExactlyOnceWith("gh", ["auth", "token", "--hostname", host, "--user", login],
      expect.objectContaining({ GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "", GH_PROMPT_DISABLED: "1" }));
  }));
});


it("scopes an unpinned environment token to the exact configured authority", async () => {
  const run = vi.fn(async () => "other-local-token");
  const env = { GH_HOST: "ghe.example.com:8443", GH_ENTERPRISE_TOKEN: "scoped-token" };
  expect(await readEnterpriseGithubToken("gh", "ghe.example.com:8443", undefined, env, run)).toBe("scoped-token");
  expect(run).not.toHaveBeenCalled();
  expect(await readEnterpriseGithubToken("gh", "ghe.example.com", undefined, env, run)).toBe("other-local-token");
  expect(run).toHaveBeenCalledExactlyOnceWith("gh", ["auth", "token", "--hostname", "ghe.example.com"],
    expect.objectContaining({ GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "" }));
});

it("discards credential material and keeps inactive signed-in accounts without making them active", () => {
  const entry = (login: string, active: boolean, state: string) =>
    ({ login, active, state, token: "do-not-return", error: "do-not-return", tokenSource: "keyring" });
  const servers = parseGithubEnterpriseAuthStatus(JSON.stringify({ hosts: {
    "github.com": [entry("public-user", true, "success")],
    "ghe.example.com": [entry("alice", true, "error"), entry("build-bot", false, "success")],
    "*.example.com": [entry("unknown", true, "success")],
  } }));
  expect(servers).toEqual([{ host: "ghe.example.com", accounts: ["build-bot"], activeLogin: undefined }]);
});


it("keeps legacy status tokens for unpinned hosts without exposing enterprise env credentials", async () => {
  await fc.assert(fc.asyncProperty(fc.nat(), async (id) => {
    const host = `ghe${id}.example.com`;
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[1] === "token") throw new Error("unknown command");
      return "Token: ghp_fixture";
    });
    expect(await readEnterpriseGithubToken("gh", host, undefined, {
      GH_HOST: "elsewhere.example.com", GH_ENTERPRISE_TOKEN: "wrong-identity",
    }, run)).toBe("ghp_fixture");
    expect(run).toHaveBeenLastCalledWith("gh", ["auth", "status", "--hostname", host, "--show-token"],
      expect.objectContaining({ GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "" }));
  }));
});
