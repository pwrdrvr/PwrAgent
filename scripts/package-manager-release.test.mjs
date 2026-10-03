import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { auditChannels, checksumFor, compareVersions, ghJson, releaseAssets, renderPackages, stableVersion, verifyFile, SOURCE_REPO, TAP_REPO, WINGET_PATH } from "./package-manager-release.mjs";
import { submitChannel } from "./submit-package-manager-release.mjs";

const version = "1.1.4";
const names = [
  `PwrAgent-${version}-arm64.dmg`, `PwrAgent-${version}-universal.dmg`,
  `PwrAgent-${version}-windows-x64-setup.exe`, "PwrAgent-macos-SHA256SUMS", "PwrAgent-windows-SHA256SUMS",
];
const release = {
  tag_name: `v${version}`, draft: false, prerelease: false,
  html_url: `https://github.com/${SOURCE_REPO}/releases/tag/v${version}`,
  assets: names.map((name) => ({ name, size: 3, browser_download_url: `https://github.com/${SOURCE_REPO}/releases/download/v${version}/${name}` })),
};
const hashes = Object.fromEntries(names.slice(0, 3).map((name, index) => [name, String(index + 1).repeat(64)]));
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("package manager release inputs", () => {
  it("rejects drafts and every unpromoted or suffixed release", () => {
    for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: "v1.1.4-beta.1" }, { tag_name: "1.1.4" }]) {
      expect(() => stableVersion({ ...release, ...patch })).toThrow(/promoted/);
    }
  });

  it("orders minor and patch versions numerically and rejects unknown ordering", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.1.3", "1.1.4")).toBe(-1);
    expect(compareVersions("1.1.4", "1.1.4")).toBe(0);
    expect(() => compareVersions("latest", "1.1.4")).toThrow();
  });

  it("requires all architecture artifacts and refuses aliases or changed sources", () => {
    expect(releaseAssets(release).map((asset) => asset.name)).toEqual(names);
    expect(() => releaseAssets({ ...release, assets: release.assets.slice(1) })).toThrow(/arm64/);
    expect(() => releaseAssets({ ...release, assets: [...release.assets, release.assets[0]] })).toThrow(/exactly one/);
    expect(() => releaseAssets({ ...release, assets: release.assets.map((a) => ({ ...a, browser_download_url: "https://example.com/file" })) })).toThrow(/URL/);
  });

  it("requires an exact unique checksum entry and verifies actual bytes, size and API digest", async () => {
    const sha = createHash("sha256").update("abc").digest("hex");
    expect(checksumFor(`${sha}  installer.exe\r\n`, "installer.exe")).toBe(sha);
    expect(() => checksumFor(`${sha}  installer.exe\n${sha}  installer.exe`, "installer.exe")).toThrow(/duplicate/);
    expect(() => checksumFor(`${sha}  other.exe`, "installer.exe")).toThrow();
    const dir = await mkdtemp(join(tmpdir(), "package-release-"));
    dirs.push(dir);
    const file = join(dir, "installer.exe");
    await writeFile(file, "abc");
    const asset = { name: "installer.exe", size: 3, digest: `sha256:${sha}` };
    expect(await verifyFile(file, asset, sha)).toBe(sha);
    await expect(verifyFile(file, { ...asset, size: 4 }, sha)).rejects.toThrow(/Size/);
    await expect(verifyFile(file, { ...asset, digest: `sha256:${"0".repeat(64)}` }, sha)).rejects.toThrow(/SHA-256/);
    await writeFile(file, "bad");
    await expect(verifyFile(file, asset, sha)).rejects.toThrow(/SHA-256/);
  });

  it("maps Apple Silicon to arm64 and Intel to universal and only advertises Windows x64", () => {
    const files = renderPackages(release, hashes);
    const cask = files["Casks/pwragent.rb"];
    expect(cask).toContain('arch arm: "arm64", intel: "universal"');
    expect(cask).toContain(`sha256 arm:   "${hashes[names[0]]}"`);
    expect(cask).toContain('depends_on macos: :monterey');
    expect(cask).not.toContain("zap trash");
    const installer = files[`${WINGET_PATH}/${version}/PwrDrvr.PwrAgent.installer.yaml`];
    expect(installer.match(/Architecture: x64/g)).toHaveLength(2);
    expect(installer).toContain("Custom: /currentuser");
    expect(installer).toContain("Custom: /allusers");
    expect(installer).not.toContain("Architecture: arm64");
    expect(installer).not.toContain("releases/latest/download");
    expect(() => renderPackages(release, {})).toThrow(/checksums/);
  });

  it("reports initial registration and pending links, and propagates API failures", () => {
    const api = (endpoint) => {
      if (/^repos\/[^/]+\/[^/?]+$/.test(endpoint)) return { private: false, default_branch: "main" };
      if (endpoint.endsWith("releases/latest")) return release;
      if (endpoint.includes("/releases?")) return [release];
      if (endpoint.startsWith("search/issues")) return { incomplete_results: false, total_count: 1, items: [{ html_url: "https://github.com/example/pull/1", title: "PwrAgent" }] };
      if (endpoint.startsWith("search/code")) return { incomplete_results: false, total_count: 0, items: [] };
      return null;
    };
    const audit = auditChannels(api);
    expect(audit.homebrew.version).toBeNull();
    expect(audit.winget.version).toBeNull();
    expect(audit.winget.pending[0].url).toContain("/pull/1");
    expect(() => auditChannels(() => { throw new Error("HTTP 403"); })).toThrow("HTTP 403");
    const official = auditChannels((endpoint) => endpoint.startsWith("search/code") && decodeURIComponent(endpoint).includes("Homebrew/homebrew-cask")
      ? { incomplete_results: false, total_count: 1, items: [{ path: "Casks/p/pwragent.rb", html_url: "https://github.com/Homebrew/homebrew-cask/blob/main/Casks/p/pwragent.rb" }] } : api(endpoint));
    expect(official.status).toBe("blocked");
    expect(official.blockers[0]).toMatch(/reconcile ownership/);
    expect(() => auditChannels((endpoint) => endpoint.startsWith("search/")
      ? { incomplete_results: true, total_count: 0, items: [] } : api(endpoint))).toThrow(/Incomplete/);
  });
});

describe("public GitHub reads", () => {
  const response = (status, body, headers = "") => ({
    status: status === 200 ? 0 : 1,
    stdout: `HTTP/2.0 ${status}\r\n${headers}\r\n${JSON.stringify(body)}`,
    stderr: status === 200 ? "" : `gh: request failed (HTTP ${status})`,
  });
  const runtime = (responses) => {
    const calls = [];
    const waits = [];
    let time = 0;
    return {
      env: { GH_TOKEN: "test-write-credential", DISTRIBUTION_READ_TOKEN: "test-read-credential" },
      now: () => time,
      run: (...args) => { calls.push(args); return responses.shift(); },
      sleep: (delay) => { waits.push(delay); time += delay; },
      calls, waits,
    };
  };

  it("uses the separate read credential and falls back without replacing the caller's write token", () => {
    const io = runtime([response(200, { ok: true }), response(200, { ok: true })]);
    ghJson("repos/public/source", false, null, io);
    expect(io.calls[0][2].env.GH_TOKEN).toBe("test-read-credential");
    expect(io.env.GH_TOKEN).toBe("test-write-credential");
    delete io.env.DISTRIBUTION_READ_TOKEN;
    ghJson("repos/public/source", false, null, io);
    expect(io.calls[1][2].env.GH_TOKEN).toBe("test-write-credential");
  });

  it("honors rate-limit reset and Retry-After, and stops after a bounded retry budget", () => {
    const limited = response(429, {}, "Retry-After: 90\r\n");
    const io = runtime([limited, response(200, { ok: true })]);
    expect(ghJson("repos/public/source", false, null, io)).toEqual({ ok: true });
    expect(io.waits).toEqual([90_000]);
    const primary = runtime([response(403, {}, "X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 120\r\n"), response(200, {})]);
    ghJson("repos/public/source", false, null, primary);
    expect(primary.waits).toEqual([120_000]);
    const exhausted = runtime([response(429, {}), response(429, {}), response(429, {})]);
    expect(() => ghJson("repos/public/source", true, null, exhausted)).toThrow(/retry later.*absence/);
    expect(exhausted.calls).toHaveLength(3);
    expect(exhausted.waits).toEqual([60_000, 120_000]);
    const longReset = runtime([response(429, {}, "Retry-After: 300\r\n")]);
    expect(() => ghJson("repos/public/source", true, null, longReset)).toThrow(/bounded/);
    expect(longReset.waits).toEqual([]);
  });

  it("treats only an optional 404 as absence and rejects partial, truncated or malformed searches", () => {
    expect(ghJson("repos/public/source", true, null, runtime([response(404, {})]))).toBeNull();
    for (const status of [401, 403, 500]) {
      const io = runtime([response(status, {})]);
      expect(() => ghJson("repos/public/source", true, null, io)).toThrow(`HTTP ${status}`);
      expect(io.calls).toHaveLength(1);
    }
    for (const body of [
      { incomplete_results: true, total_count: 0, items: [] },
      { incomplete_results: false, total_count: 101, items: [] },
      { items: [] },
    ]) {
      expect(() => ghJson("search/code?q=PwrAgent", false, null, runtime([response(200, body)]))).toThrow(/Incomplete/);
    }
    expect(ghJson("search/code?q=PwrAgent", false, null, runtime([
      response(200, { incomplete_results: false, total_count: 0, items: [] }),
    ])).total_count).toBe(0);
  });
});

describe("channel submission", () => {
  const input = { target: TAP_REPO, fork: TAP_REPO, version, files: { "Casks/pwragent.rb": "test" } };
  const noApi = () => { throw new Error("Unexpected external call"); };

  it("reports publication or pending review without duplicate writes", async () => {
    expect((await submitChannel({ ...input, channel: { version, pending: [] } }, noApi, noApi)).state).toBe("published-in-repository");
    const pending = [{ url: "https://github.com/example/pull/1" }];
    expect((await submitChannel({ ...input, channel: { version: null, pending } }, noApi, noApi)).submissions).toEqual(pending);
    await expect(submitChannel({ ...input, channel: { version: "1.2.0", pending: [] } }, noApi, noApi)).rejects.toThrow(/downgrade/);
  });

  it("refuses wrong forks and changed reviewed branches", async () => {
    await expect(submitChannel({ ...input, fork: "example/fork", channel: { version: null, pending: [] } }, () => ({ parent: { full_name: "wrong/repo" } }), noApi)).rejects.toThrow(/must be a fork/);
    const api = (endpoint) => {
      if (endpoint.endsWith(TAP_REPO)) return { default_branch: "main" };
      if (endpoint.includes("git/ref")) return { object: { sha: "head" } };
      return { content: Buffer.from("different").toString("base64") };
    };
    await expect(submitChannel({ ...input, channel: { version: null, pending: [] } }, api, noApi)).rejects.toThrow(/review manually/);
  });
});
