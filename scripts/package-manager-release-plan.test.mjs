import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPackages, SOURCE_REPO, TAP_REPO, WINGET_REPO, WINGET_PATH } from "./package-manager-release.mjs";
import {
  assetKey, buildPlan, cachedAsset, imageMatches, metadataPackages, prepare,
  reusableValidation, selectImage, validationCode, validationKey,
} from "./package-manager-release-plan.mjs";
import { installationCopy, serveInstallers, writeInstallationCopies } from "./package-manager-release-loopback.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
function release(version) {
  const names = [`PwrAgent-${version}-arm64.dmg`, `PwrAgent-${version}-universal.dmg`,
    `PwrAgent-${version}-windows-x64-setup.exe`, "PwrAgent-macos-SHA256SUMS", "PwrAgent-windows-SHA256SUMS"];
  return { tag_name: `v${version}`, html_url: "release", draft: false, prerelease: false,
    assets: names.map((name, id) => ({ id: id + 1, name, size: 3, digest: `sha256:${sha("abc")}`,
      browser_download_url: `https://github.com/${SOURCE_REPO}/releases/download/v${version}/${name}` })),
  };
}
const current = release("1.1.4");
const previous = release("1.1.3");
const event = { event: "schedule", ref: "refs/heads/main", logic: "validator-code" };
const dirs = [];
const servers = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temporary() { const dir = await mkdtemp(resolve(tmpdir(), "distribution-plan-")); dirs.push(dir); return dir; }
function apiFixture({ published = false, pending = false, hit = false, cacheRef = "refs/heads/main", winget = "v1.12.0", downloads = 0 } = {}) {
  return vi.fn((endpoint) => {
    if (/^repos\/[^/]+\/[^/?]+$/.test(endpoint)) return { private: false, default_branch: "main" };
    if (endpoint === `repos/${SOURCE_REPO}/releases/latest`) return structuredClone(current);
    if (endpoint === `repos/${SOURCE_REPO}/releases/tags/${previous.tag_name}`) return structuredClone(previous);
    if (endpoint.includes(`${SOURCE_REPO}/releases?`)) return [current, previous];
    if (endpoint.includes(`${TAP_REPO}/contents`) || endpoint.includes(`${WINGET_REPO}/contents/${WINGET_PATH}`)) {
      const publishedRelease = published ? current : previous;
      const version = publishedRelease.tag_name.slice(1);
      const hashes = Object.fromEntries(publishedRelease.assets.slice(0, 3).map((asset) => [asset.name, asset.digest.slice(7)]));
      const files = renderPackages(publishedRelease, hashes);
      const path = endpoint.includes(`${TAP_REPO}/contents`)
        ? "Casks/pwragent.rb" : `${WINGET_PATH}/${version}/PwrDrvr.PwrAgent.installer.yaml`;
      if (endpoint.includes(".installer.yaml") || endpoint.includes(`${TAP_REPO}/contents`)) {
        return { encoding: "base64", content: Buffer.from(files[path]).toString("base64") };
      }
      return [{ type: "dir", name: version }];
    }
    if (endpoint.startsWith("search/")) {
      const items = pending && endpoint.startsWith("search/issues") ? [{ html_url: "pending", title: "PwrAgent" }] : [];
      return { incomplete_results: false, total_count: items.length, items };
    }
    if (endpoint.startsWith("repos/Homebrew/homebrew-")) return null;
    if (endpoint.startsWith("repos/actions/runner-images/releases")) return [
      { tag_name: "macos-26-arm64/20260907.1", body: "Image Version: 20260907.1" },
      { tag_name: "macos-26/20260824.1", body: "Image Version: 20260824.1" },
      { tag_name: "win25-vs2026/20260927.1", body: "Image Version: 20260927.1" },
    ];
    if (endpoint === "repos/Homebrew/brew/releases/latest") return { tag_name: "5.1.0" };
    if (endpoint === "repos/Homebrew/brew/commits/5.1.0") return { sha: "a".repeat(40) };
    if (endpoint === "repos/microsoft/winget-cli/releases/latest") return {
      tag_name: winget, assets: ["Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle", "DesktopAppInstaller_Dependencies.zip"]
        .map((name) => ({ name, size: 3, digest: `sha256:${sha("client")}`, download_count: downloads })),
    };
    if (endpoint.includes("/actions/caches?")) return { actions_caches: hit ? [{ key: decodeURIComponent(endpoint.split("&key=")[1]), ref: cacheRef }] : [] };
    throw new Error(`Unexpected API read: ${endpoint}`);
  });
}

describe("metadata-only distribution planning", () => {
  it("leaves published and pending daily channels alone before cache/platform/asset resolution", async () => {
    for (const options of [{ published: true }, { pending: true }]) {
      const api = apiFixture(options);
      const plan = await buildPlan(event, api);
      expect(plan.needed).toBe(false);
      expect(plan.assets).toEqual([]);
      expect(api.mock.calls.some(([endpoint]) => /actions\/caches|runner-images|winget-cli/.test(endpoint))).toBe(false);
    }
  });

  it("preserves blocked ownership evidence without resolving native runners or caches", async () => {
    const base = apiFixture();
    const api = vi.fn((endpoint, ...args) => endpoint.startsWith("search/code") && decodeURIComponent(endpoint).includes("Homebrew/homebrew-cask")
      ? { incomplete_results: false, total_count: 1, items: [{ path: "Casks/p/pwragent.rb", html_url: "https://github.com/Homebrew/homebrew-cask/blob/main/Casks/p/pwragent.rb" }] }
      : base(endpoint, ...args));
    const plan = await buildPlan(event, api);
    expect(plan.audit.status).toBe("blocked");
    expect(plan.needed).toBe(false);
    expect(plan.submit).toBe(false);
    expect(plan.native).toEqual([]);
    expect(plan.assets).toEqual([]);
    expect(api.mock.calls.some(([endpoint]) => /actions\/caches|runner-images|winget-cli/.test(endpoint))).toBe(false);
    const dir = await mkdtemp(resolve(tmpdir(), "distribution-blocked-"));
    dirs.push(dir);
    await prepare(plan, dir);
    expect(JSON.parse(await readFile(resolve(dir, "preflight.json"), "utf8")).blockers[0]).toMatch(/reconcile ownership/);
  });

  it.each(["pull_request", "workflow_dispatch", "schedule"])("reuses identical successful %s candidates before native jobs/downloads", async (name) => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected download"); }));
    const plan = await buildPlan({ ...event, event: name, ref: name === "pull_request" ? "refs/pull/2532/merge" : event.ref }, apiFixture({ hit: true }));
    expect(plan.native.every((platform) => platform.reuse)).toBe(true);
    expect(plan.assets).toEqual([]);
    expect(plan.submit).toBe(name !== "pull_request");
    const dir = await temporary();
    await prepare(plan, dir);
    expect(await readFile(resolve(dir, "current/audit.json"), "utf8")).toContain('"previousVersion": "1.1.3"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forces coverage without losing immutable byte cache keys", async () => {
    const cached = await buildPlan(event, apiFixture({ hit: true }));
    const forced = await buildPlan({ ...event, force: true }, apiFixture({ hit: true }));
    expect(forced.native.every((platform) => !platform.reuse)).toBe(true);
    expect(forced.assets).toHaveLength(10);
    expect(forced.native.map(({ key }) => key)).toEqual(cached.native.map(({ key }) => key));
    const changed = await buildPlan({ ...event, logic: "new-validator" }, apiFixture());
    expect(changed.assets.map(({ key }) => key)).toEqual(forced.assets.map(({ key }) => key));
    expect(changed.native[0].key).not.toBe(forced.native[0].key);
  });

  it("never lets untrusted PR success authorize trusted submission or another PR", () => {
    const caches = [{ key: "key", ref: "refs/pull/2532/merge" }];
    expect(reusableValidation(caches, "key", { event: "pull_request", ref: "refs/pull/2532/merge" })).toBe(true);
    expect(reusableValidation(caches, "key", { event: "pull_request", ref: "refs/pull/999/merge" })).toBe(false);
    for (const name of ["schedule", "release", "workflow_dispatch"]) {
      expect(reusableValidation(caches, "key", { event: name, ref: "refs/heads/main" })).toBe(false);
    }
    expect(reusableValidation([{ key: "key-prefix", ref: event.ref }], "key", event)).toBe(false);
    expect(reusableValidation([{ key: "key", ref: event.ref }], "key", { ...event, force: true })).toBe(false);
  });

  it("reuses manual branch validation without allowing it to authorize publication", async () => {
    const ref = "refs/heads/test-distribution";
    const api = apiFixture({ hit: true, cacheRef: ref });
    const local = await buildPlan({ ...event, event: "workflow_dispatch", ref, publication: false }, api);
    expect(local.native.every(({ reuse }) => reuse)).toBe(true);
    const submit = await buildPlan({ ...event, event: "workflow_dispatch", ref, publication: true }, api);
    expect(submit.native.some(({ reuse }) => reuse)).toBe(false);
    expect(reusableValidation([{ key: "key", ref: "refs/tags/v1.1.4" }], "key", { ...event, tag: "v1.1.4" })).toBe(true);
    expect(reusableValidation([{ key: "key", ref: "refs/tags/v1.1.3" }], "key", { ...event, tag: "v1.1.4" })).toBe(false);
  });

  it("does not invalidate validation when mutable WinGet download counters change", async () => {
    const before = await buildPlan(event, apiFixture({ downloads: 12 }));
    const after = await buildPlan(event, apiFixture({ downloads: 99 }));
    expect(before.native.map(({ key }) => key)).toEqual(after.native.map(({ key }) => key));
  });

  it("invalidates changed bytes, baseline, generated packages, validator logic and platform/tool inputs", () => {
    const input = { current, previous, files: metadataPackages(current).files, logic: "logic",
      platform: { image: "20260907.1", tool: "1.12", arch: "X64" } };
    const key = validationKey(input);
    for (const patch of [
      { current: release("1.1.5") }, { previous: release("1.1.2") },
      { files: { ...input.files, "Casks/pwragent.rb": "changed" } }, { logic: "changed" },
      { platform: { ...input.platform, image: "20260908.1" } },
      { platform: { ...input.platform, tool: "1.13" } },
      { platform: { ...input.platform, arch: "ARM64" } },
    ]) expect(validationKey({ ...input, ...patch })).not.toBe(key);
    const asset = current.assets[0];
    expect(assetKey(current.tag_name, asset)).not.toBe(assetKey(current.tag_name, { ...asset, digest: `sha256:${sha("bad")}` }));
    expect(() => assetKey(current.tag_name, { ...asset, digest: null })).toThrow(/digest/);
  });

  it("covers only the affected platform when validator code or installer bytes change", async () => {
    const workflow = "jobs:\n  prepare:\n    plan\n  homebrew:\n    brew\n  winget:\n    winget\n  submit:\n    submit\n";
    const sources = { common: "verify", loopback: "mirror" };
    expect(validationCode(workflow, "homebrew", sources)).toBe(validationCode(workflow, "homebrew", { ...sources, loopback: "changed" }));
    expect(validationCode(workflow, "winget", sources)).not.toBe(validationCode(workflow, "winget", { ...sources, loopback: "changed" }));
    expect(validationCode(workflow, "winget", sources)).toBe(validationCode(workflow.replace("    brew", "    changed brew"), "winget", sources));
    const before = await buildPlan({ ...event, logic: { homebrew: "mac", winget: "windows" } }, apiFixture());
    const after = await buildPlan({ ...event, logic: { homebrew: "changed mac", winget: "windows" } }, apiFixture());
    expect(before.native[0].key).not.toBe(after.native[0].key);
    expect(before.native[2].key).toBe(after.native[2].key);
    const baseApi = apiFixture();
    const api = (endpoint, ...args) => {
      const value = baseApi(endpoint, ...args);
      if (endpoint === `repos/${SOURCE_REPO}/releases/latest`) value.assets[2].digest = `sha256:${sha("changed Windows bytes")}`;
      return value;
    };
    const changed = await buildPlan(event, api);
    const baseline = await buildPlan(event, apiFixture());
    expect(changed.native[0].key).toBe(baseline.native[0].key);
    expect(changed.native[2].key).not.toBe(baseline.native[2].key);
  });

  it("pins resolved WinGet version and fails closed on missing image metadata or a rollout mismatch", async () => {
    const before = await buildPlan(event, apiFixture());
    const after = await buildPlan(event, apiFixture({ winget: "v1.13.0" }));
    expect(before.native[0].key).toBe(after.native[0].key);
    expect(before.native[2].key).not.toBe(after.native[2].key);
    expect(() => selectImage([], "win25/")).toThrow(/resolve/);
    expect(imageMatches("20260907.0351.1", "20260907.351.1")).toBe(true);
    expect(imageMatches("20260907.1", "20260908.1")).toBe(false);
    expect(imageMatches(undefined, "20260908.1")).toBe(false);
  });

  it("verifies cached bytes on every use and refuses corrupt restores without copying or replacing them", async () => {
    const dir = await temporary();
    const asset = current.assets[0];
    const key = assetKey(current.tag_name, asset);
    const plan = { assets: [{ asset, key, role: "current" }] };
    const fetchAsset = vi.fn(async () => new Response("abc"));
    vi.stubGlobal("fetch", fetchAsset);
    await cachedAsset(plan, 0, resolve(dir, "first"), resolve(dir, "cache"));
    await cachedAsset(plan, 0, resolve(dir, "second"), resolve(dir, "cache"));
    expect(fetchAsset).toHaveBeenCalledTimes(1);
    await cachedAsset({ assets: [{ asset, key, role: "previous" }] }, 0, resolve(dir, "baseline"), resolve(dir, "cache"));
    expect(await readFile(resolve(dir, "baseline/assets/previous", asset.name), "utf8")).toBe("abc");
    expect(fetchAsset).toHaveBeenCalledTimes(1);
    await writeFile(resolve(dir, "cache", key, asset.name), "bad");
    await expect(cachedAsset(plan, 0, resolve(dir, "bad"), resolve(dir, "cache"))).rejects.toThrow(/SHA-256/);
    await expect(readFile(resolve(dir, "bad/assets", asset.name))).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetchAsset).toHaveBeenCalledTimes(1);
  });
});

describe("WinGet installation-only mirror", () => {
  it("changes only both production InstallerUrl fields, retaining hashes and scopes", () => {
    const text = metadataPackages(current).files[`${WINGET_PATH}/1.1.4/PwrDrvr.PwrAgent.installer.yaml`];
    const copy = installationCopy(text, "1.1.4", "http://127.0.0.1:1234");
    expect(copy.match(/InstallerUrl: http:\/\/127.0.0.1:1234/g)).toHaveLength(2);
    expect(copy).toContain(`InstallerSha256: ${sha("abc").toUpperCase()}`);
    expect(copy.replaceAll("http://127.0.0.1:1234/PwrAgent-1.1.4-windows-x64-setup.exe",
      `https://github.com/${SOURCE_REPO}/releases/download/v1.1.4/PwrAgent-1.1.4-windows-x64-setup.exe`)).toBe(text);
    expect(() => installationCopy(text, "1.1.4", "http://example.com:1234")).toThrow(/loopback/);
    expect(() => installationCopy(text.replaceAll("https://github.com", "https://example.com"), "1.1.4", "http://127.0.0.1:1234")).toThrow(/production/);
  });

  it("serves only verified current/previous bytes, supports HEAD/ranges and preserves original manifests", async () => {
    const dir = await temporary();
    const plan = { current, previous, files: { current: metadataPackages(current).files, previous: metadataPackages(previous).files } };
    for (const role of ["current", "previous"]) {
      const root = resolve(dir, "assets", role === "previous" ? "previous" : "");
      await mkdir(root, { recursive: true });
      await writeFile(resolve(root, plan[role].assets[2].name), "abc");
    }
    await prepare({ ...plan, audit: { stable: { version: "1.1.4" } }, needed: true, native: [], hashes: metadataPackages(current).hashes }, dir);
    const { server, base } = await serveInstallers(dir, plan);
    servers.push(server);
    await writeInstallationCopies(dir, plan, base);
    const url = `${base}/${current.assets[2].name}`;
    expect(await (await fetch(url)).text()).toBe("abc");
    expect((await fetch(url, { method: "HEAD" })).headers.get("content-length")).toBe("3");
    const range = await fetch(url, { headers: { Range: "bytes=1-2" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("bc");
    expect((await fetch(`${base}/plan.json`)).status).toBe(404);
    expect((await fetch(url, { headers: { Range: "bytes=9-10" } })).status).toBe(416);
    const path = `${WINGET_PATH}/1.1.4/PwrDrvr.PwrAgent.installer.yaml`;
    expect(await readFile(resolve(dir, "current", path), "utf8")).not.toContain(base);
    expect(await readFile(resolve(dir, "installation/current", path), "utf8")).toContain(base);
    await writeFile(resolve(dir, "assets", current.assets[2].name), "bad");
    await expect(serveInstallers(dir, plan)).rejects.toThrow(/SHA-256/);
  });
});
