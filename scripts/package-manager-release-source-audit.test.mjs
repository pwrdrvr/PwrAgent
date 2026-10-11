import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditChannels, auditFailure, renderPackages, requireCompleteAudit, SOURCE_REPO, TAP_REPO, WINGET_REPO, WINGET_PATH, PACKAGE_ID } from "./package-manager-release.mjs";
import { buildPlan } from "./package-manager-release-plan.mjs";
import { caskMetadata, wingetMetadata } from "./package-manager-release-source-audit.mjs";

const version = "1.1.4";
const commit = "a".repeat(40);
const names = [`PwrAgent-${version}-arm64.dmg`, `PwrAgent-${version}-universal.dmg`, `PwrAgent-${version}-windows-x64-setup.exe`, "PwrAgent-macos-SHA256SUMS", "PwrAgent-windows-SHA256SUMS"];
const hashes = Object.fromEntries(names.map((name, index) => [name, String(index + 1).repeat(64)]));
const release = { tag_name: `v${version}`, draft: false, prerelease: false, html_url: "release",
  assets: names.map((name) => ({ name, size: 3, digest: `sha256:${hashes[name]}`,
    browser_download_url: `https://github.com/${SOURCE_REPO}/releases/download/v${version}/${name}` })),
};
const files = renderPackages(release, hashes);
const manifest = `${WINGET_PATH}/${version}/${PACKAGE_ID}.installer.yaml`;
const encode = (content) => ({ encoding: "base64", content: Buffer.from(content).toString("base64") });
const search = (items) => ({ incomplete_results: false, total_count: items.length, items });
const dirs = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function fixture({ sources = files, data = release, override = () => undefined } = {}) {
  return vi.fn((endpoint) => {
    const custom = override(endpoint);
    if (custom !== undefined) return custom;
    if (/^repos\/[^/]+\/[^/?]+$/.test(endpoint)) return { private: false, full_name: endpoint.slice(6), default_branch: "master" };
    if (endpoint.includes("/commits/")) return { sha: commit };
    if (endpoint.endsWith("releases/latest")) return data;
    if (endpoint.startsWith("search/")) return search([]);
    if (endpoint.includes("/contents/")) {
      if (endpoint.includes("repos/Homebrew/homebrew-")) return null;
      if (endpoint.includes(`${TAP_REPO}/`)) return sources["Casks/pwragent.rb"] === undefined ? null : encode(sources["Casks/pwragent.rb"]);
      if (endpoint.includes(".installer.yaml")) return encode(sources[manifest]);
      if (endpoint.includes(WINGET_PATH)) return sources[manifest] === undefined ? null : [{ type: "dir", name: version }];
    }
    throw new Error(`Unexpected fixture read: ${endpoint}`);
  });
}

describe("published source integrity", () => {
  it("pins source reads to public repository commits and verifies matching current sources without asset requests", () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected asset request"); }));
    const api = fixture();
    const audit = auditChannels(api);
    expect(audit.status).toBe("complete");
    expect(audit.homebrew.source).toContain(`/blob/${commit}/Casks/pwragent.rb`);
    expect(audit.winget.installers.map((item) => item.scope)).toEqual(["user", "machine"]);
    expect(api.mock.calls.filter(([endpoint]) => endpoint.includes("/contents/")).every(([endpoint]) => endpoint.endsWith(`?ref=${commit}`))).toBe(true);
    expect(api.mock.calls.some(([endpoint]) => /search\/code|releases\/download|releases\?/.test(endpoint))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["Casks/pwragent.rb", manifest])("blocks same-version hash and mutable URL drift in %s before planning installers", async (path) => {
    const checksum = path.endsWith(".rb") ? hashes[names[0]] : hashes[names[2]];
    for (const contents of [files[path].replace(checksum, "f".repeat(64)), files[path].replace(checksum.toUpperCase(), "f".repeat(64)),
      files[path].replace("releases/download/", "releases/latest/download/")]) {
      if (contents === files[path]) continue;
      const api = fixture({ sources: { ...files, [path]: contents } });
      const plan = await buildPlan({ event: "schedule", ref: "refs/heads/main", logic: "test" }, api);
      expect(plan.audit.status).toBe("blocked");
      expect(plan.audit.findings[0].kind).toBe("drift");
      expect(plan.needed).toBe(false);
      expect(plan.assets).toEqual([]);
      expect(() => requireCompleteAudit(plan.audit)).toThrow(/blocked/);
      expect(api.mock.calls.some(([endpoint]) => /actions\/|runner-images|winget-cli/.test(endpoint))).toBe(false);
    }
  });

  it.each([undefined, "sha256:bad"])("reports missing/invalid release digests as unverifiable rather than successful: %s", (digest) => {
    const data = structuredClone(release);
    data.assets[0].digest = digest;
    const audit = auditChannels(fixture({ data }));
    expect(audit.status).toBe("blocked");
    expect(audit.findings[0].kind).toBe("unverifiable");
  });

  it("compares a behind channel with its own stable release, and rejects an unpromoted source version", () => {
    const latest = { ...release, tag_name: "v1.1.5" };
    const api = fixture({ data: latest, override: (endpoint) => endpoint.endsWith(`/releases/tags/v${version}`) ? release : undefined });
    expect(auditChannels(api).homebrew.comparison).toBe("behind-github-latest");
    expect(auditChannels(api).status).toBe("complete");
    const audit = auditChannels(fixture({ data: latest, override: (endpoint) => endpoint.includes("/releases/tags/") ? { ...release, prerelease: true } : undefined }));
    expect(audit.findings[0].message).toMatch(/published stable/);
  });

  it("keeps Winget preflight independent of Homebrew sources and code-search availability", () => {
    const api = fixture({ override: (endpoint) => {
      if (/Homebrew|homebrew|search\/code/.test(endpoint)) throw new Error("Unrelated service unavailable");
    } });
    const audit = auditChannels(api, { families: ["winget"] });
    expect(audit.status).toBe("complete");
    expect(audit.homebrew.status).toBe("not-checked");
    expect(api.mock.calls.some(([endpoint]) => /Homebrew|homebrew|search\/code/.test(endpoint))).toBe(false);
  });

  it("retains direct official Homebrew detection before search indexing", () => {
    const api = fixture({ override: (endpoint) => endpoint.includes("Homebrew/homebrew-cask/contents/") ? encode("new source") : undefined });
    const audit = auditChannels(api, { families: ["homebrew"] });
    expect(audit.status).toBe("blocked");
    expect(audit.findings[0].message).toMatch(/reconcile ownership/);
    expect(api.mock.calls.some(([endpoint]) => endpoint.startsWith("search/code"))).toBe(false);
  });

  it("confirms public repository identity before accepting known-path absence", () => {
    expect(auditChannels(fixture({ sources: {} })).status).toBe("complete");
    for (const patch of [{ private: true }, { full_name: "other/owner" }, { default_branch: "" }]) {
      const api = fixture({ override: (endpoint) => endpoint === `repos/${TAP_REPO}`
        ? { private: false, full_name: TAP_REPO, default_branch: "main", ...patch } : undefined });
      expect(() => auditChannels(api)).toThrow(/expected public/);
    }
  });
});

describe("literal metadata parsing", () => {
  it("accepts cask whitespace/quotes and YAML reordered/inherited fields without executing their source", () => {
    expect(caskMetadata(files["Casks/pwragent.rb"].replaceAll('"', "'").replace("arch arm:", "arch   arm:")).installers).toHaveLength(2);
    const yaml = `PackageIdentifier: '${PACKAGE_ID}'\r\nPackageVersion: "${version}" # stable\r\nArchitecture: x64\r\nInstallerUrl: ${release.assets[2].browser_download_url}\r\nInstallerSha256: ${hashes[names[2]]}\r\nInstallers:\r\n- Scope: machine\r\n- Scope: user\r\nManifestType: installer\r\n`;
    expect(wingetMetadata(yaml, PACKAGE_ID, version).installers.map((item) => item.scope)).toEqual(["machine", "user"]);
  });

  it.each([
    (value) => value.replace(`PackageIdentifier: ${PACKAGE_ID}`, "PackageIdentifier: Other.Agent"),
    (value) => value.replace("Scope: machine", "Scope: user"),
    (value) => value.replace("Architecture: x64", "Architecture: arm64"),
    (value) => value.replace("PackageVersion:", `PackageVersion: ${version}\nPackageVersion:`),
  ])("rejects identity, duplicate key and architecture/scope changes", (change) => {
    const audit = auditChannels(fixture({ sources: { ...files, [manifest]: change(files[manifest]) } }));
    expect(audit.status).toBe("blocked");
    expect(audit.winget.status).toBe("blocked");
    expect(audit.findings[0].kind).toBe("unverifiable");
  });

  it("refuses dynamic/ambiguous cask metadata and YAML aliases", () => {
    expect(() => caskMetadata(files["Casks/pwragent.rb"].replace(`version "${version}"`, "version ENV.fetch('VERSION')"))).toThrow(/literal/);
    expect(() => caskMetadata(files["Casks/pwragent.rb"].replace('arch arm:', 'arch arm: "arm64", arm:'))).toThrow(/literal/);
    expect(() => wingetMetadata(files[manifest].replace("Architecture: x64", "Architecture: *arch"), PACKAGE_ID, version)).toThrow(/scalar/);
  });
});

describe("optional identity discovery and structured failures", () => {
  it("ignores documentation and unrelated casks, and reports beta/alternate registrations for review without automatically blocking", () => {
    const api = fixture({ override: (endpoint) => {
      if (endpoint.startsWith("search/code")) return search([
        { path: "README.md" }, { path: "Casks/pwragent-beta.rb" }, { path: "Casks/unrelated.rb" }, { path: "manifests/o/Other/Agent/1.0/Other.Agent.locale.en-US.yaml" },
      ]);
      if (endpoint.includes("/contents/Casks/pwragent-beta.rb")) return encode('homepage "https://pwragent.ai/"');
      if (endpoint.includes("/contents/Casks/unrelated.rb")) return encode('homepage "https://unrelated.example/"');
      if (endpoint.includes("/contents/manifests/o/")) return encode("PackageName: PwrAgent\n");
    } });
    const audit = auditChannels(api, { discover: true });
    expect(audit.status).toBe("complete");
    expect(audit.discoveries.some((item) => item.repository === WINGET_REPO && item.path.startsWith("manifests/o/"))).toBe(true);
    expect(audit.discoveries.some((item) => item.path === "Casks/pwragent-beta.rb")).toBe(true);
    expect(audit.discoveries.some((item) => /README|unrelated/.test(item.path))).toBe(false);
    expect(audit.discovery).toMatch(/index lag/);
  });

  it("keeps structured drift evidence when rejecting an audit", () => {
    const audit = auditChannels(fixture({ sources: { ...files, "Casks/pwragent.rb": "unsupported" } }));
    try { requireCompleteAudit(audit); } catch (error) { expect(auditFailure(error)).toBe(audit); }
  });

  it("writes JSON incomplete results for CLI/API failures and planner preflight, with no raw subprocess error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-audit-cli-"));
    dirs.push(dir);
    const preload = join(dir, "read-fixture.cjs");
    await writeFile(preload, `const child = require("node:child_process");
const original = child.spawnSync;
child.spawnSync = (command, ...args) => command === "gh"
  ? { status: 1, stdout: "HTTP/2.0 403\\r\\n\\r\\n{}", stderr: "private subprocess details" }
  : original(command, ...args);
require("node:module").syncBuiltinESMExports();
`);
    const env = { ...process.env, GH_TOKEN: "fixture", DISTRIBUTION_READ_TOKEN: "fixture", GH_DEBUG: "api" };
    const audit = spawnSync(process.execPath, ["--require", preload, resolve("scripts/package-manager-release.mjs"), "--audit"], { env, encoding: "utf8" });
    expect(audit.status).toBe(1);
    expect(JSON.parse(audit.stdout).status).toBe("incomplete");
    expect(audit.stdout + audit.stderr).not.toContain("private subprocess details");
    const plan = spawnSync(process.execPath, ["--require", preload, resolve("scripts/package-manager-release-plan.mjs"), "plan", join(dir, "plan")], { env, encoding: "utf8" });
    expect(plan.status).toBe(1);
    expect(JSON.parse(await readFile(join(dir, "plan/preflight.json"), "utf8")).status).toBe("incomplete");
  });
});
