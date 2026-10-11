#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { caskMetadata, wingetMetadata, installerFindings } from "./package-manager-release-source-audit.mjs";

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
  if (env.DISTRIBUTION_READ_TOKEN && !endpoint.includes("/actions/caches")) env.GH_TOKEN = env.DISTRIBUTION_READ_TOKEN;
  let waited = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = runtime.run("gh", args, { encoding: "utf8", env, timeout: 45_000, maxBuffer: 16 * 1024 * 1024 });
    const response = (result.stdout ?? "").split(/\r?\n\r?\n/);
    const headers = response.shift() ?? "";
    const header = (name) => headers.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1].trim();
    const status = Number(headers.match(/^HTTP\/\S+\s+(\d+)/)?.[1])
      || Number(result.stderr?.match(/HTTP (\d+)/)?.[1]);
    if (result.status === 0) {
      try {
        return JSON.parse(response.join("\n\n"));
      } catch {
        throw new Error(`Malformed GitHub response at ${endpoint.split("?")[0]}`);
      }
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
    throw new Error(`GitHub API ${endpoint.split("?")[0]}: HTTP ${status || "unavailable"}${limited ? "; bounded rate-limit retries exhausted; retry later, do not infer absence" : "; read incomplete, do not infer absence"}`);
  }
}

export function ghJson(endpoint, optional = false, projection = null, runtime = readRuntime) {
  if (!endpoint.startsWith("search/")) return ghPage(endpoint, optional, projection, runtime);
  if (projection) throw new Error("Search metadata must remain available for completeness validation");
  const url = new URL(endpoint, "https://api.github.com/");
  url.searchParams.set("per_page", "100");
  const items = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= 10; page++) {
    url.searchParams.set("page", String(page));
    const result = ghPage(url.pathname.slice(1) + url.search, false, null, runtime);
    if (result.incomplete_results !== false || !Number.isInteger(result.total_count)
      || result.total_count < 0 || result.total_count > 1000 || !Array.isArray(result.items) || result.items.length > 100) {
      throw new Error("Incomplete GitHub search; narrow the query or retry later; no absence conclusion");
    }
    total ??= result.total_count;
    if (result.total_count !== total) throw new Error("Incomplete GitHub search: count changed during pagination");
    for (const item of result.items) {
      const key = item.html_url ?? item.id;
      if (key === undefined || seen.has(key)) throw new Error("Incomplete GitHub search: duplicate or malformed page");
      seen.add(key);
    }
    items.push(...result.items);
    if (items.length === total) return { incomplete_results: false, total_count: total, items };
    if (result.items.length !== 100 || items.length > total) break;
  }
  throw new Error("Incomplete GitHub search pagination; no absence conclusion");
}

export function publishedReleases(api = ghJson) {
  const endpoint = `repos/${SOURCE_REPO}/releases?per_page=100&page=`;
  const projection = "map({id,tag_name,draft,prerelease,updated_at})";
  const releases = [];
  const seen = new Set();
  let first;
  for (let page = 1; page <= 20; page++) {
    const batch = api(endpoint + page, false, projection);
    if (!Array.isArray(batch) || batch.length > 100) throw new Error("Incomplete release pagination: invalid page");
    first ??= JSON.stringify(batch);
    for (const release of batch) {
      const key = release.id ?? release.tag_name;
      if (!release.tag_name || key === undefined || seen.has(key)) throw new Error("Incomplete release pagination: duplicate or malformed release");
      seen.add(key);
    }
    releases.push(...batch);
    if (batch.length < 100) {
      if (page > 1 && JSON.stringify(api(endpoint + "1", false, projection)) !== first) {
        throw new Error("Incomplete release pagination: releases changed during traversal; retry later");
      }
      return releases;
    }
  }
  throw new Error("Release pagination limit reached; select an upgrade baseline manually");
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

export function auditChannels(api = ghJson, { families = ["homebrew", "winget"], discover = false } = {}) {
  const latest = api(`repos/${SOURCE_REPO}/releases/latest`);
  const version = stableVersion(latest);
  const findings = [];
  const snapshots = new Map();
  const releases = new Map([[version, latest]]);
  const snapshot = (repo) => {
    if (!snapshots.has(repo)) {
      const metadata = api(`repos/${repo}`);
      if (metadata.private !== false || metadata.full_name?.toLowerCase() !== repo.toLowerCase() || !metadata.default_branch) {
        throw new Error(`Cannot confirm expected public source repository: ${repo}`);
      }
      const commit = api(`repos/${repo}/commits/${encodeURIComponent(metadata.default_branch)}`).sha;
      if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error(`Cannot pin authoritative source commit: ${repo}`);
      snapshots.set(repo, commit);
    }
    return snapshots.get(repo);
  };
  const source = (repo, path, optional = false) => {
    const commit = snapshot(repo);
    const file = api(`repos/${repo}/contents/${path}?ref=${commit}`, optional);
    return { file, url: `https://github.com/${repo}/blob/${commit}/${path}`, commit };
  };
  const text = (file) => {
    if (file?.encoding !== "base64" || typeof file.content !== "string") throw new Error("Missing authoritative source content");
    return Buffer.from(file.content, "base64").toString("utf8");
  };
  const pending = (repo) => completeSearchItems(api(`search/issues?per_page=100&q=${encodeURIComponent(`repo:${repo} is:pr is:open PwrAgent`)}`))
    .map(({ html_url, title }) => ({ url: html_url, title }));
  const inspect = (family, channel, input, parse, platform) => {
    channel.source = input.url;
    channel.commit = input.commit;
    if (!input.file) return;
    try {
      Object.assign(channel, parse(text(input.file)));
    } catch (error) {
      findings.push({ channel: family, kind: "unverifiable", source: input.url, message: error.message });
      return;
    }
    if (!releases.has(channel.version)) releases.set(channel.version, api(`repos/${SOURCE_REPO}/releases/tags/v${channel.version}`));
    const release = releases.get(channel.version);
    if (release.tag_name !== `v${channel.version}` || release.draft || release.prerelease) {
      findings.push({ channel: family, kind: "drift", source: input.url, message: "Source version does not name a published stable release" });
      return;
    }
    findings.push(...installerFindings(channel, platform, release, SOURCE_REPO)
      .map((finding) => ({ ...finding, channel: family, source: input.url })));
  };
  const homebrew = { token: "pwrdrvr/tap/pwragent", repository: TAP_REPO, version: null, installers: [], pending: [] };
  const winget = { identifier: PACKAGE_ID, repository: WINGET_REPO, version: null, installers: [], pending: [] };
  if (families.includes("homebrew")) {
    inspect("homebrew", homebrew, source(TAP_REPO, "Casks/pwragent.rb", true), caskMetadata, "macos");
    for (const [repo, path] of [["Homebrew/homebrew-cask", "Casks/p/pwragent.rb"], ["Homebrew/homebrew-core", "Formula/p/pwragent.rb"]]) {
      const input = source(repo, path, true);
      if (input.file) findings.push({ channel: "homebrew", kind: "drift", source: input.url, message: "PwrAgent exists in official Homebrew; reconcile ownership" });
    }
    homebrew.pending = pending(TAP_REPO);
  }
  if (families.includes("winget")) {
    const directory = source(WINGET_REPO, WINGET_PATH, true);
    winget.source = directory.url;
    winget.commit = directory.commit;
    if (directory.file !== null) {
      if (!Array.isArray(directory.file) || directory.file.length >= 1000) throw new Error("Incomplete authoritative Winget version directory");
      const versions = directory.file.filter((entry) => entry.type === "dir").map((entry) => entry.name).sort(compareVersions);
      const published = versions.at(-1);
      if (!published) throw new Error("Winget directory has no recognizable versions");
      inspect("winget", winget, source(WINGET_REPO, `${WINGET_PATH}/${published}/${PACKAGE_ID}.installer.yaml`),
        (contents) => wingetMetadata(contents, PACKAGE_ID, published), "windows");
    }
    winget.pending = pending(WINGET_REPO);
  }
  const discoveries = [];
  if (discover) {
    const repos = [
      ...(families.includes("homebrew") ? [TAP_REPO, "Homebrew/homebrew-cask", "Homebrew/homebrew-core"] : []),
      ...(families.includes("winget") ? [WINGET_REPO] : []),
    ];
    for (const repo of repos) {
      const matches = new Map();
      for (const term of ["PwrAgent", '"pwragent.ai"']) {
        for (const item of completeSearchItems(api(`search/code?per_page=100&q=${encodeURIComponent(`repo:${repo} ${term}`)}`))) {
          if (typeof item.path !== "string") throw new Error("Incomplete package identity search: missing source path");
          matches.set(item.path, item);
        }
      }
      for (const path of matches.keys()) {
        const packageFile = repo === WINGET_REPO ? /^manifests\/.*\.yaml$/.test(path) : /^(Casks|Formula)\/.*\.rb$/.test(path);
        if (!packageFile || (repo === TAP_REPO && path === "Casks/pwragent.rb")
          || (repo === WINGET_REPO && path.startsWith(`${WINGET_PATH}/`))) continue;
        const input = source(repo, path);
        const contents = text(input.file);
        if (!/(?:https?:\/\/pwragent\.ai(?:\/|["'\s]|$)|PackageName:\s*["']?PwrAgent["']?\s*$|name\s+["']PwrAgent["'])/m.test(contents)) continue;
        discoveries.push({ repository: repo, path, source: input.url, commit: input.commit,
          review: "Inspect this registration before deciding whether ownership conflicts; separate beta identities may be intentional" });
      }
    }
  }
  for (const [family, channel] of [["homebrew", homebrew], ["winget", winget]]) {
    channel.status = !families.includes(family) ? "not-checked"
      : findings.some((item) => item.channel === family) ? "blocked" : "complete";
    channel.comparison = !channel.version ? "not-published-at-known-path"
      : compareVersions(channel.version, version) === 0 ? "matches-github-latest"
        : compareVersions(channel.version, version) < 0 ? "behind-github-latest" : "ahead-of-github-latest";
  }
  return {
    status: findings.length ? "blocked" : "complete", checkedAt: new Date().toISOString(),
    stable: { version, url: latest.html_url }, homebrew, winget, findings, discoveries,
    discovery: discover ? "Complete indexed searches only; index lag prevents exhaustive absence conclusions" : "not-requested",
    verification: "Source metadata and release JSON only; no asset requests or client installation checks",
  };
}

export function requireCompleteAudit(audit) {
  if (audit.status === "complete") return;
  const error = new Error(`Channel audit blocked: ${audit.findings.map((finding) => finding.message).join("; ")}`);
  error.audit = audit;
  throw error;
}

export function auditFailure(error) {
  return error.audit ?? { status: "incomplete", checkedAt: new Date().toISOString(), error: error.message };
}

export function distributionNeeded(audit, event, tag = "") {
  if (tag && tag !== `v${audit.stable.version}`) return false;
  return ["pull_request", "workflow_dispatch"].includes(event)
    || [audit.homebrew, audit.winget].some((channel) =>
      channel.version !== audit.stable.version && channel.pending.length === 0);
}

// A tag/URL alone is mutable. Reuse requires every asset's API identity and digest.
export function candidateKey(releases) {
  const identities = releases.map((release) => ({
    tag: release.tag_name,
    assets: releaseAssets(release).map(({ id, name, size, digest, browser_download_url }) =>
      ({ id, name, size, digest, browser_download_url })),
  }));
  if (identities.some(({ assets }) => assets.some((asset) =>
    !Number.isSafeInteger(asset.id) || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)))) return null;
  return createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}

export function previousRelease(version, api = ghJson) {
  const releases = publishedReleases(api);
  const candidates = releases.filter((item) => !item.draft && !item.prerelease && /^v\d+\.\d+\.\d+$/.test(item.tag_name))
    .filter((item) => compareVersions(item.tag_name.slice(1), version) < 0)
    .sort((a, b) => compareVersions(a.tag_name.slice(1), b.tag_name.slice(1)));
  const previous = candidates.at(-1);
  if (!previous) throw new Error("No previous stable release; select an upgrade baseline manually");
  return api(`repos/${SOURCE_REPO}/releases/tags/${encodeURIComponent(previous.tag_name)}`);
}

function acquireBuildArtifact(asset, file) {
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) throw new Error(`Missing GitHub digest: ${asset.name}`);
  execFileSync("python3", [fileURLToPath(new URL("./build-artifact.py", import.meta.url)),
    "--url", asset.browser_download_url, "--sha256", asset.digest.slice(7), "--size", String(asset.size), "--output", file],
  { stdio: "inherit" });
}

export async function download(asset, dir, acquire = acquireBuildArtifact) {
  const file = resolve(dir, asset.name);
  try {
    await stat(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log(`Build artifact acquisition (cache miss): ${asset.name}`);
    await acquire(asset, file);
  }
  return file;
}

export async function materializeRelease(release, out, cache, acquire) {
  await mkdir(cache, { recursive: true });
  const assets = releaseAssets(release);
  for (const asset of assets) await download(asset, cache, acquire);
  for (const asset of assets.slice(3)) {
    if (asset.digest) await verifyFile(resolve(cache, asset.name), asset, asset.digest.replace(/^sha256:/, ""));
  }
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
    if (!["--audit", "--discover", "--out", "--tag", "--assets", "--previous-out", "--candidate-key"].includes(key)) throw new Error(`Unknown argument ${key}`);
    options[key] = ["--audit", "--discover", "--candidate-key"].includes(key) ? true : argv[++i];
    if (!options[key]) throw new Error(`Missing value for ${key}`);
  }
  if (options["--discover"] && !options["--audit"]) throw new Error("Use --discover only with the read-only --audit command");
  if (options["--candidate-key"]) {
    const release = ghJson(`repos/${SOURCE_REPO}/releases/latest`);
    console.log(candidateKey([release, previousRelease(stableVersion(release))]) ?? "");
    return;
  }
  const audit = auditChannels(ghJson, { discover: !!options["--discover"] });
  console.log(JSON.stringify(audit, null, 2));
  if (audit.status !== "complete") { process.exitCode = 1; return; }
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
    previous = previousRelease(version);
    await materializeRelease(previous, resolve(options["--previous-out"]), resolve(cache, "previous"));
  }
  await writeFile(resolve(out, "audit.json"), JSON.stringify({ ...audit, hashes, previousVersion: previous?.tag_name.slice(1) ?? null }, null, 2) + "\n");
  console.log(`Verified release bytes and generated Homebrew/Winget inputs in ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.log(JSON.stringify(auditFailure(error), null, 2));
    process.exitCode = 1;
  });
}
