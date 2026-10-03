#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export const SOURCE_REPO = "pwrdrvr/PwrAgent";
export const TAP_REPO = "pwrdrvr/homebrew-tap";
export const WINGET_REPO = "microsoft/winget-pkgs";
export const PACKAGE_ID = "PwrDrvr.PwrAgent";
export const WINGET_PATH = "manifests/p/PwrDrvr/PwrAgent";
export const SCHEMA_VERSION = "1.12.0";

export function completeSearchItems(result) {
  if (result.incomplete_results !== false || !Array.isArray(result.items)
    || !Number.isInteger(result.total_count) || result.total_count !== result.items.length) {
    throw new Error("Incomplete GitHub search; narrow the query or retry later before deciding package/submission absence");
  }
  return result.items;
}

const readRuntime = {
  run: spawnSync,
  now: Date.now,
  env: process.env,
  sleep(milliseconds) {
    // Keep each blocking wait bounded, including a server-requested reset delay.
    while (milliseconds > 0) {
      const chunk = Math.min(milliseconds, 60_000);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, chunk);
      milliseconds -= chunk;
    }
  },
};

function ghPage(endpoint, optional = false, projection = null, runtime = readRuntime) {
  if (endpoint.startsWith("search/") && projection) throw new Error("Search metadata must remain available for completeness validation");
  const args = ["api", "--include", endpoint];
  if (projection) args.push("--jq", projection);
  // Only this GET helper uses the read credential. Submission writes keep GH_TOKEN.
  const env = { ...runtime.env, GH_DEBUG: "" };
  if (env.DISTRIBUTION_READ_TOKEN) env.GH_TOKEN = env.DISTRIBUTION_READ_TOKEN;
  let waited = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = runtime.run("gh", args, { encoding: "utf8", env, timeout: 45_000, maxBuffer: 16 * 1024 * 1024 });
    const response = (result.stdout ?? "").split(/\r?\n\r?\n/);
    const headers = response.shift() ?? "";
    const header = (name) => headers.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1].trim();
    const status = Number(headers.match(/^HTTP\/\S+\s+(\d+)/)?.[1])
      || Number(result.stderr?.match(/HTTP (\d+)/)?.[1]);
    if (result.status === 0) {
      let json;
      try {
        json = JSON.parse(response.join("\n\n"));
      } catch {
        throw new Error(`Malformed GitHub API response at ${endpoint.split("?")[0]}; audit blocked`);
      }
      if (endpoint.startsWith("search/") && (json.incomplete_results !== false
        || !Number.isInteger(json.total_count) || json.total_count < 0 || json.total_count > 1000
        || !Array.isArray(json.items) || json.items.length > 100)) {
        throw new Error("Incomplete GitHub search; narrow the query or retry later; no absence conclusion");
      }
      return json;
    }
    // A throttled, unauthorized or incomplete query is never package absence.
    if (optional && status === 404) return null;
    const limited = status === 429 || (status === 403
      && (header("retry-after") || header("x-ratelimit-remaining") === "0"
        || /rate limit/i.test(`${result.stderr}\n${response.join("\n\n")}`)));
    if (limited && attempt < 2) {
      const retryAfter = header("retry-after");
      const retryDelay = retryAfter ? (Number.isFinite(Number(retryAfter))
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - runtime.now()) : 0;
      const resetDelay = header("x-ratelimit-remaining") === "0"
        ? Number(header("x-ratelimit-reset")) * 1000 - runtime.now() : 0;
      const delay = Math.max(retryDelay, resetDelay, 60_000 * 2 ** attempt);
      // Respect longer server delays by stopping, never retrying prematurely.
      if (Number.isFinite(delay) && waited + delay <= 180_000) {
        runtime.sleep(delay);
        waited += delay;
        continue;
      }
    }
    throw new Error(`GitHub API ${endpoint.split("?")[0]}: HTTP ${status || "unavailable"}${limited ? "; bounded rate-limit retries exhausted; retry later, do not infer absence" : "; audit blocked, no absence conclusion"}`);
  }
}

// Search pages must be complete and stable before callers can infer absence.
export function ghJson(endpoint, optional = false, projection = null, runtime = readRuntime) {
  if (!endpoint.startsWith("search/")) return ghPage(endpoint, optional, projection, runtime);
  if (projection) throw new Error("Search metadata must remain available for completeness validation");
  const items = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= 10; page++) {
    const result = ghPage(`${endpoint}&page=${page}`, false, null, runtime);
    total ??= result.total_count;
    if (result.total_count !== total) throw new Error("Incomplete GitHub search: results changed during pagination; retry later");
    for (const item of result.items) {
      const key = item.html_url ?? item.id;
      if (key === undefined || seen.has(key)) throw new Error("Incomplete GitHub search: duplicate or malformed page; retry later");
      seen.add(key);
    }
    items.push(...result.items);
    if (items.length === total) return { incomplete_results: false, total_count: total, items };
    if (!result.items.length || items.length > total) break;
  }
  throw new Error("Incomplete GitHub search pagination; narrow the query or retry later; no absence conclusion");
}

export function publishedReleases(api = ghJson) {
  const releases = [];
  for (let page = 1; page <= 20; page++) {
    const batch = api(`repos/${SOURCE_REPO}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("Malformed GitHub releases response");
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error("Release pagination limit reached; select an upgrade baseline manually");
}

const sourceText = (file) => {
  if (file?.encoding !== "base64" || typeof file.content !== "string") throw new Error("Missing authoritative source content");
  return Buffer.from(file.content, "base64").toString("utf8");
};

export function caskMetadata(text) {
  const version = /^  version "([^"\n]+)"$/m.exec(text)?.[1];
  const arch = /^  arch arm: "([^"\n]+)", intel: "([^"\n]+)"$/m.exec(text);
  const hashes = /^  sha256 arm: +"([a-f0-9]{64})",\s+intel: "([a-f0-9]{64})"$/m.exec(text);
  const url = /^  url "([^"\n]+)"$/m.exec(text)?.[1];
  if (!version || !arch || !hashes || !url || !/^cask "pwragent" do$/m.test(text)) {
    throw new Error("Authoritative PwrAgent cask layout changed; inspect its version, architectures, URL and hashes");
  }
  compareVersions(version, version);
  if (arch[1] !== "arm64" || arch[2] !== "universal") throw new Error("PwrAgent cask architectures changed; inspect source");
  return { version, installers: ["arm64", "universal"].map((architecture, index) => ({
    architecture,
    url: url.replaceAll("#{version}", version).replaceAll("#{arch}", architecture),
    sha256: hashes[index + 1],
  })) };
}

export function wingetMetadata(text, version) {
  if (!new RegExp(`^PackageIdentifier: ${PACKAGE_ID.replaceAll(".", "\\.")}\\r?$`, "m").test(text)
    || !text.split(/\r?\n/).includes(`PackageVersion: ${version}`)) {
    throw new Error("Authoritative Winget package identity/version changed; inspect source");
  }
  const installers = [...text.matchAll(/^  - Architecture: (\S+)\r?\n    Scope: (\S+)\r?\n    InstallerUrl: (\S+)\r?\n    InstallerSha256: ([A-Fa-f0-9]{64})\r?$/gm)]
    .map((match) => ({ architecture: match[1], scope: match[2], url: match[3], sha256: match[4].toLowerCase() }));
  if (installers.length !== 2 || (text.match(/^\s*- Architecture:/gm) ?? []).length !== installers.length
    || installers.some((item) => item.architecture !== "x64")
    || new Set(installers.map((item) => item.scope)).size !== 2
    || installers.some((item) => !["user", "machine"].includes(item.scope))) {
    throw new Error("Authoritative Winget installer layout changed; inspect architectures, scopes, URLs and hashes");
  }
  return { version, installers };
}

export function stableVersion(release) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error("Package channels require a published, promoted, suffix-free stable release");
  }
  return release.tag_name.slice(1);
}

export function compareVersions(left, right) {
  if (![left, right].every((v) => /^\d+\.\d+\.\d+$/.test(v))) {
    throw new Error(`Cannot compare stable versions: ${left}, ${right}`);
  }
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  }
  return 0;
}

export function releaseAssets(release) {
  const version = stableVersion(release);
  const names = [
    `PwrAgent-${version}-arm64.dmg`,
    `PwrAgent-${version}-universal.dmg`,
    `PwrAgent-${version}-windows-x64-setup.exe`,
    "PwrAgent-macos-SHA256SUMS",
    "PwrAgent-windows-SHA256SUMS",
  ];
  return names.map((name) => {
    const matches = release.assets.filter((asset) => asset.name === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one released asset: ${name}`);
    const asset = matches[0];
    const expected = `https://github.com/${SOURCE_REPO}/releases/download/${release.tag_name}/${name}`;
    if (asset.browser_download_url !== expected || !(asset.size > 0)) {
      throw new Error(`Unexpected URL or size for ${name}`);
    }
    return asset;
  });
}

export function checksumFor(contents, name) {
  const matches = contents.split(/\r?\n/).filter((line) => line.endsWith(`  ${name}`));
  if (matches.length !== 1 || !/^[a-f0-9]{64}  /.test(matches[0])) {
    throw new Error(`Missing, duplicate or invalid published checksum for ${name}`);
  }
  return matches[0].slice(0, 64);
}

export async function verifyFile(file, asset, checksum) {
  if ((await stat(file)).size !== asset.size) throw new Error(`Size mismatch for ${asset.name}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== checksum || (asset.digest && asset.digest !== `sha256:${actual}`)) {
    throw new Error(`SHA-256 mismatch for ${asset.name}`);
  }
  return actual;
}

export function renderPackages(release, hashes) {
  const version = stableVersion(release);
  const base = `https://github.com/${SOURCE_REPO}/releases/download/v${version}`;
  const arm = hashes[`PwrAgent-${version}-arm64.dmg`];
  const intel = hashes[`PwrAgent-${version}-universal.dmg`];
  const windows = hashes[`PwrAgent-${version}-windows-x64-setup.exe`];
  if (![arm, intel, windows].every((sha) => /^[a-f0-9]{64}$/.test(sha))) {
    throw new Error("All architecture checksums must be verified before rendering");
  }
  const cask = `# frozen_string_literal: true

cask "pwragent" do
  arch arm: "arm64", intel: "universal"

  version "${version}"
  sha256 arm:   "${arm}",
         intel: "${intel}"

  url "https://github.com/${SOURCE_REPO}/releases/download/v#{version}/PwrAgent-#{version}-#{arch}.dmg"
  name "PwrAgent"
  desc "Thread-centric coding agent desktop app"
  homepage "https://pwragent.ai/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :monterey

  app "PwrAgent.app"

  # Preserve ~/.pwragent: it contains profiles, secrets and thread state.
end
`;
  const header = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${SCHEMA_VERSION}.schema.json\nPackageIdentifier: ${PACKAGE_ID}\nPackageVersion: ${version}\n`;
  const footer = (type) => `ManifestType: ${type}\nManifestVersion: ${SCHEMA_VERSION}\n`;
  const files = {
    "Casks/pwragent.rb": cask,
    [`${WINGET_PATH}/${version}/${PACKAGE_ID}.yaml`]: header("version")
      + `DefaultLocale: en-US\n` + footer("version"),
    [`${WINGET_PATH}/${version}/${PACKAGE_ID}.installer.yaml`]: header("installer")
      + `InstallerType: nullsoft
UpgradeBehavior: install
Installers:
  - Architecture: x64
    Scope: user
    InstallerUrl: ${base}/PwrAgent-${version}-windows-x64-setup.exe
    InstallerSha256: ${windows.toUpperCase()}
    InstallerSwitches:
      Custom: /currentuser
  - Architecture: x64
    Scope: machine
    InstallerUrl: ${base}/PwrAgent-${version}-windows-x64-setup.exe
    InstallerSha256: ${windows.toUpperCase()}
    InstallerSwitches:
      Custom: /allusers
` + footer("installer"),
    [`${WINGET_PATH}/${version}/${PACKAGE_ID}.locale.en-US.yaml`]: header("defaultLocale")
      + `PackageLocale: en-US
Publisher: PwrDrvr LLC
PublisherUrl: https://pwrdrvr.com/
PublisherSupportUrl: https://github.com/${SOURCE_REPO}/issues
PackageName: PwrAgent
PackageUrl: https://pwragent.ai/
License: MIT
LicenseUrl: https://github.com/${SOURCE_REPO}/blob/v${version}/LICENSE
ShortDescription: Thread-centric coding agent desktop app
ReleaseNotesUrl: https://github.com/${SOURCE_REPO}/releases/tag/v${version}
` + footer("defaultLocale"),
  };
  return files;
}

export function auditChannels(api = ghJson) {
  const repos = [SOURCE_REPO, TAP_REPO, WINGET_REPO, "Homebrew/homebrew-cask", "Homebrew/homebrew-core"];
  const branches = {};
  for (const repo of repos) {
    const metadata = api(`repos/${repo}`);
    if (metadata.private !== false || !metadata.default_branch) throw new Error(`Audit blocked: ${repo} is not confirmed readable and public`);
    branches[repo] = metadata.default_branch;
  }
  const latest = api(`repos/${SOURCE_REPO}/releases/latest`);
  const version = stableVersion(latest);
  const promoted = publishedReleases(api).filter((item) => !item.draft && !item.prerelease && /^v\d+\.\d+\.\d+$/.test(item.tag_name))
    .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
  const path = (repo, file) => `repos/${repo}/contents/${file}?ref=${encodeURIComponent(branches[repo])}`;
  const source = (repo, file) => `https://github.com/${repo}/blob/${branches[repo]}/${file}`;
  const search = (kind, repo, suffix = "", term = "PwrAgent") => completeSearchItems(api(`search/${kind}?per_page=100&q=${encodeURIComponent(`repo:${repo} ${term} ${suffix}`)}`));
  const links = (items) => items.map(({ html_url, title, path, state, draft }) => ({ url: html_url, title, path, state, draft }));
  const cask = api(path(TAP_REPO, "Casks/pwragent.rb"), true);
  const homebrew = cask ? caskMetadata(sourceText(cask)) : { version: null, installers: [] };
  const entries = api(path(WINGET_REPO, WINGET_PATH), true);
  if (entries !== null && !Array.isArray(entries)) throw new Error("Malformed authoritative Winget directory");
  const wingetVersions = (entries ?? []).filter((entry) => entry.type === "dir").map((entry) => entry.name).sort(compareVersions);
  if (entries !== null && !wingetVersions.length) throw new Error("Winget directory has no recognizable versions; inspect source");
  const wingetVersion = wingetVersions.at(-1) ?? null;
  const installerPath = wingetVersion && `${WINGET_PATH}/${wingetVersion}/${PACKAGE_ID}.installer.yaml`;
  const winget = installerPath ? wingetMetadata(sourceText(api(path(WINGET_REPO, installerPath))), wingetVersion) : { version: null, installers: [] };
  const identities = {};
  // Sequential reads avoid bursting GitHub's separate code-search budget.
  for (const repo of repos.slice(1)) {
    const matches = [...search("code", repo), ...search("code", repo, "", "\"pwragent.ai\"")];
    identities[repo] = links([...new Map(matches.map((item) => [item.html_url, item])).values()]);
  }
  const blockers = [];
  if (identities["Homebrew/homebrew-cask"].length || identities["Homebrew/homebrew-core"].length) {
    blockers.push("PwrAgent exists in official Homebrew; reconcile ownership before updating the tap");
  }
  if (identities[WINGET_REPO].some((item) => !item.path?.startsWith(`${WINGET_PATH}/`))) {
    blockers.push("Alternate Winget identity discovered; inspect source before registering/updating");
  }
  if (identities[TAP_REPO].some((item) => /^(Casks|Formula)\//.test(item.path ?? "") && item.path !== "Casks/pwragent.rb")) {
    blockers.push("Alternate Homebrew identity discovered; reconcile tap ownership");
  }
  const evidence = (channel) => {
    if (!channel.version) return "not-published-at-known-path";
    const order = compareVersions(channel.version, version);
    return order === 0 ? "matches-github-latest" : order < 0 ? "behind-github-latest" : "ahead-of-github-latest";
  };
  for (const [channel, platform] of [[homebrew, "macos"], [winget, "windows"]]) {
    if (!channel.version) continue;
    const release = channel.version === version ? latest : api(`repos/${SOURCE_REPO}/releases/tags/v${channel.version}`);
    stableVersion(release);
    for (const installer of channel.installers) {
      const name = platform === "macos" ? `PwrAgent-${channel.version}-${installer.architecture}.dmg` : `PwrAgent-${channel.version}-windows-x64-setup.exe`;
      const expected = `https://github.com/${SOURCE_REPO}/releases/download/v${channel.version}/${name}`;
      const asset = release.assets.filter((item) => item.name === name);
      if (installer.url !== expected || asset.length !== 1 || asset[0].browser_download_url !== expected
        || (asset[0].digest && asset[0].digest !== `sha256:${installer.sha256}`)) {
        blockers.push(`Published package URL/checksum differs from release asset: ${name}; inspect authoritative source`);
      }
    }
  }
  return {
    status: blockers.length ? "blocked" : "complete",
    checkedAt: new Date().toISOString(),
    stable: { version, url: latest.html_url },
    highestPromotedStable: promoted[0] && { version: promoted[0].tag_name.slice(1), url: promoted[0].html_url },
    assets: releaseAssets(latest).map((asset) => ({ name: asset.name, url: asset.browser_download_url, digest: asset.digest, bytes: asset.size })),
    homebrew: { ...homebrew, token: "pwrdrvr/tap/pwragent", repository: TAP_REPO, source: source(TAP_REPO, "Casks/pwragent.rb"),
      comparison: evidence(homebrew), pending: links(search("issues", TAP_REPO, "is:pr is:open")), submissions: links(search("issues", TAP_REPO, "is:pr")) },
    winget: { ...winget, identifier: PACKAGE_ID, repository: WINGET_REPO,
      source: installerPath ? source(WINGET_REPO, installerPath) : `https://github.com/${WINGET_REPO}/tree/${branches[WINGET_REPO]}/${WINGET_PATH}`,
      comparison: evidence(winget), pending: links(search("issues", WINGET_REPO, "is:pr is:open")), submissions: links(search("issues", WINGET_REPO, "is:pr")) },
    identities,
    blockers,
    verification: "Remote source metadata and available GitHub digests only; downloaded-byte, signature, install/upgrade and refreshed-client validation remain required",
  };
}

async function download(asset, dir) {
  const file = resolve(dir, asset.name);
  try {
    await stat(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(asset.browser_download_url);
    if (!response.ok) throw new Error(`Download ${asset.name}: HTTP ${response.status}`);
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(`${file}.part`));
      const { rename } = await import("node:fs/promises");
      await rename(`${file}.part`, file);
    } finally {
      await rm(`${file}.part`, { force: true });
    }
  }
  return file;
}

export async function materializeRelease(release, out, cache) {
  await mkdir(cache, { recursive: true });
  const assets = releaseAssets(release);
  for (const asset of assets) await download(asset, cache);
  const manifests = await Promise.all(assets.slice(3).map((asset) => readFile(resolve(cache, asset.name), "utf8")));
  const hashes = {};
  for (const [index, asset] of assets.slice(0, 3).entries()) {
    const expected = checksumFor(manifests[index === 2 ? 1 : 0], asset.name);
    hashes[asset.name] = await verifyFile(resolve(cache, asset.name), asset, expected);
  }
  for (const [path, contents] of Object.entries(renderPackages(release, hashes))) {
    const file = resolve(out, path);
    await mkdir(resolve(file, ".."), { recursive: true });
    // winget-pkgs requests CRLF for YAML; the cask retains LF.
    await writeFile(file, path.endsWith(".yaml") ? contents.replaceAll("\n", "\r\n") : contents);
  }
  return hashes;
}

async function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!["--audit", "--out", "--tag", "--assets", "--previous-out"].includes(key)) throw new Error(`Unknown argument ${key}`);
    options[key] = key === "--audit" ? true : argv[++i];
    if (!options[key]) throw new Error(`Missing value for ${key}`);
  }
  const audit = auditChannels();
  console.log(JSON.stringify(audit, null, 2));
  if (audit.status === "blocked") { process.exitCode = 1; return; }
  if (options["--audit"]) return;
  if (!options["--out"]) throw new Error("Use --audit, or --out <directory> [--tag vX.Y.Z] [--assets <cache>]");
  const tag = options["--tag"] ?? `v${audit.stable.version}`;
  const release = ghJson(`repos/${SOURCE_REPO}/releases/tags/${encodeURIComponent(tag)}`);
  const version = stableVersion(release);
  if (version !== audit.stable.version) throw new Error("Generate only the current promoted GitHub Latest release");
  for (const channel of [audit.homebrew, audit.winget]) {
    if (channel.version && compareVersions(version, channel.version) < 0) {
      throw new Error(`Refusing channel downgrade from ${channel.version} to ${version}`);
    }
  }
  const out = resolve(options["--out"]);
  const cache = resolve(options["--assets"] ?? `${out}/assets`);
  const hashes = await materializeRelease(release, out, cache);
  let previous = null;
  if (options["--previous-out"]) {
    const releases = publishedReleases();
    const candidates = releases.filter((item) => !item.draft && !item.prerelease && /^v\d+\.\d+\.\d+$/.test(item.tag_name))
      .filter((item) => compareVersions(item.tag_name.slice(1), version) < 0)
      .sort((a, b) => compareVersions(a.tag_name.slice(1), b.tag_name.slice(1)));
    previous = candidates.at(-1);
    if (!previous) throw new Error("No previous promoted stable release; select an upgrade baseline manually");
    previous = ghJson(`repos/${SOURCE_REPO}/releases/tags/${encodeURIComponent(previous.tag_name)}`);
    await materializeRelease(previous, resolve(options["--previous-out"]), resolve(cache, "previous"));
  }
  await writeFile(resolve(out, "audit.json"), JSON.stringify({ ...audit, hashes, previousVersion: previous?.tag_name.slice(1) ?? null }, null, 2) + "\n");
  console.log(`Verified release bytes and generated Homebrew/Winget inputs in ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.log(JSON.stringify({ status: "blocked", checkedAt: new Date().toISOString(), error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
