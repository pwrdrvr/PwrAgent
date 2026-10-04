#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditChannels, distributionNeeded, ghJson, previousRelease, stableVersion,
  releaseAssets, renderPackages, verifyFile, download, compareVersions, SOURCE_REPO,
} from "./package-manager-release.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const DEFAULT_REF = "refs/heads/main";
export const PLATFORMS = [
  { runner: "macos-26", imagePrefix: "macos-26-arm64/", arch: "ARM64", family: "homebrew" },
  { runner: "macos-26-intel", imagePrefix: "macos-26/", arch: "X64", family: "homebrew" },
  // runner-images README maps windows-2025 to the VS2026 image family.
  { runner: "windows-2025", imagePrefix: "win25-vs2026/", arch: "X64", family: "winget" },
];

// Installer bytes do not depend on automation code, platform or current/previous role.
export function assetKey(tag, asset) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error(`Missing immutable asset digest: ${asset.name}`);
  }
  return `distribution-byte-v2-${tag}-${asset.name}-${asset.digest.slice(7)}`;
}

export function metadataPackages(release) {
  const hashes = Object.fromEntries(releaseAssets(release).slice(0, 3).map((asset) => {
    assetKey(release.tag_name, asset);
    return [asset.name, asset.digest.slice(7)];
  }));
  return { hashes, files: renderPackages(release, hashes) };
}

export function validationCode(workflow, family, sources) {
  const section = (name) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    if (start < 0) throw new Error(`Missing workflow validator job: ${name}`);
    const end = workflow.slice(start + 1).search(/\n  [a-z]+:\n/);
    return end < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + end);
  };
  const code = { ...sources, workflow: section("prepare") + section(family) };
  if (family !== "winget") delete code.loopback;
  return digest(code);
}

export function validationKey({ current, previous, files, logic, platform }) {
  return `distribution-validation-v3-${digest({ current, previous, files, logic, platform })}`;
}

export function reusableValidation(caches, key, { event, ref, tag, force = false, publication = true }) {
  if (force) return false;
  // Only main and the promoted stable tag can authorize publication. PRs and
  // manual validation-only dispatches may additionally consume their own ref.
  const allowed = [DEFAULT_REF];
  if (/^v\d+\.\d+\.\d+$/.test(tag ?? "")) allowed.push(`refs/tags/${tag}`);
  if (event === "pull_request") {
    if (!/^refs\/pull\/\d+\/merge$/.test(ref)) return false;
    allowed.push(ref);
  } else if (event === "workflow_dispatch" && !publication && /^refs\/heads\//.test(ref)) allowed.push(ref);

  return caches.some((cache) => cache.key === key && allowed.includes(cache.ref));
}

export function selectImage(releases, prefix) {
  const image = releases.find((release) => !release.draft && release.tag_name.startsWith(prefix));
  const version = image?.body?.match(/Image Version[^\d]*([\d.]+)/)?.[1];
  if (!image || !version) throw new Error(`Cannot resolve published hosted image: ${prefix}`);
  return { tag: image.tag_name, version };
}

export function imageMatches(actual, expected) {
  const normalize = (value) => value?.split(".").map(Number).join(".");
  return !!actual && normalize(actual) === normalize(expected);
}

async function writePackages(out, files) {
  for (const [path, contents] of Object.entries(files)) {
    const file = resolve(out, path);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, path.endsWith(".yaml") ? contents.replaceAll("\n", "\r\n") : contents);
  }
}

export async function buildPlan({ event, ref, tag = "", force = false, publication = true, logic }, api = ghJson) {
  const audit = auditChannels(api);
  const needed = distributionNeeded(audit, event, tag);
  const plan = { audit, needed, native: [], assets: [], submit: false };
  // Preserve the daily publication/pending-PR guard before asset/cache resolution.
  if (!needed) return plan;
  const current = api(`repos/${SOURCE_REPO}/releases/latest`);
  if (stableVersion(current) !== audit.stable.version) throw new Error("GitHub Latest changed during planning; retry");
  for (const channel of [audit.homebrew, audit.winget]) {
    if (channel.version && compareVersions(audit.stable.version, channel.version) < 0) throw new Error("Refusing channel downgrade");
  }
  const previous = previousRelease(stableVersion(current), api);
  const currentInputs = metadataPackages(current);
  const previousInputs = metadataPackages(previous);
  const images = api("repos/actions/runner-images/releases?per_page=100", false,
    'map({tag_name, draft, body: (.body | split("\\n") | map(select(contains("Image Version"))) | join("\\n"))})');
  const brewRelease = api("repos/Homebrew/brew/releases/latest");
  if (brewRelease.draft || brewRelease.prerelease) throw new Error("Homebrew validator must be stable");
  const brew = api(`repos/Homebrew/brew/commits/${encodeURIComponent(brewRelease.tag_name)}`).sha;
  if (!/^[a-f0-9]{40}$/.test(brew)) throw new Error("Cannot pin Homebrew validator");
  const winget = api("repos/microsoft/winget-cli/releases/latest");
  if (winget.draft || winget.prerelease) throw new Error("WinGet client must be stable");
  const wingetAssets = ["Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle", "DesktopAppInstaller_Dependencies.zip"].map((name) => {
    const matches = winget.assets.filter((asset) => asset.name === name);
    if (matches.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest)) throw new Error(`Missing WinGet digest: ${name}`);
    const { id, name: assetName, size, digest, browser_download_url } = matches[0];
    return { id, name: assetName, size, digest, browser_download_url };
  });
  const files = { current: currentInputs.files, previous: previousInputs.files };
  for (const platform of PLATFORMS) {
    const inputs = {
      ...platform, image: selectImage(images, platform.imagePrefix),
      tool: platform.family === "homebrew" ? { brew } : { tag: winget.tag_name, assets: wingetAssets },
    };
    const relevantAsset = (asset) => inputs.family === "homebrew"
      ? /\.dmg$|macos-SHA256SUMS$/.test(asset.name) : /\.exe$|windows-SHA256SUMS$/.test(asset.name);
    const identity = (release) => ({ version: stableVersion(release), assets: releaseAssets(release)
      .filter(relevantAsset).map(({ name, size, digest, id }) => ({ name, size, digest, id })) });
    const relevantFiles = Object.fromEntries(Object.entries(files).map(([role, packages]) => [role,
      Object.fromEntries(Object.entries(packages).filter(([path]) => inputs.family === "homebrew"
        ? path.startsWith("Casks/") : path.endsWith(".yaml"))),
    ]));
    const key = validationKey({ current: identity(current), previous: identity(previous), files: relevantFiles,
      logic: typeof logic === "string" ? logic : logic[inputs.family], platform: inputs });
    const result = api(`repos/${SOURCE_REPO}/actions/caches?per_page=100&key=${encodeURIComponent(key)}`);
    if (!Array.isArray(result.actions_caches)) throw new Error("Cannot inspect successful validation cache");
    const reuse = reusableValidation(result.actions_caches, key, { event, ref, tag: current.tag_name, force, publication });
    plan.native.push({ ...inputs, key, reuse });
  }
  const families = new Set(plan.native.filter((platform) => !platform.reuse).map((platform) => platform.family));
  for (const [role, release] of [["current", current], ["previous", previous]]) {
    for (const [index, asset] of releaseAssets(release).entries()) {
      const family = index === 2 || index === 4 ? "winget" : "homebrew";
      if (!families.has(family)) continue;
      plan.assets.push({ role, asset, key: assetKey(release.tag_name, asset) });
    }
  }
  Object.assign(plan, { current, previous, files, hashes: currentInputs.hashes,
    submit: event !== "pull_request" && [audit.homebrew, audit.winget].some((channel) =>
      channel.version !== audit.stable.version && channel.pending.length === 0),
  });
  return plan;
}

export async function prepare(plan, dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "preflight.json"), JSON.stringify(plan.audit, null, 2) + "\n");
  await writeFile(resolve(dir, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  if (!plan.needed) return;
  await writePackages(resolve(dir, "current"), plan.files.current);
  await writePackages(resolve(dir, "previous"), plan.files.previous);
  await writeFile(resolve(dir, "current/audit.json"), JSON.stringify({ ...plan.audit, hashes: plan.hashes,
    previousVersion: stableVersion(plan.previous), validation: plan.native.map(({ runner, key, reuse }) => ({ runner, key, reuse })),
  }, null, 2) + "\n");
}

export async function cachedAsset(plan, index, dir, cacheRoot = ".local/distribution-assets") {
  const { role, asset, key } = plan.assets[index];
  const cache = resolve(cacheRoot, key);
  await mkdir(cache, { recursive: true });
  const file = await download(asset, cache);
  // A corrupt restore fails closed. Never save, copy or install unchecked bytes.
  await verifyFile(file, asset, asset.digest.slice(7));
  console.log(`Verified release asset: ${asset.name}`);
  const target = resolve(dir, "assets", role === "previous" ? "previous" : "");
  await mkdir(target, { recursive: true });
  await copyFile(file, resolve(target, asset.name));
}

async function main(argv) {
  const [command, dir = "distribution", index] = argv;
  if (command === "plan") {
    const workflow = await readFile(".github/workflows/package-manager-distribution.yml", "utf8");
    const sources = {
      assetAction: await readFile(".github/actions/distribution-asset/action.yml", "utf8"),
      release: await readFile("scripts/package-manager-release.mjs", "utf8"),
      planner: await readFile("scripts/package-manager-release-plan.mjs", "utf8"),
      loopback: await readFile("scripts/package-manager-release-loopback.mjs", "utf8"),
    };
    const logic = Object.fromEntries(["homebrew", "winget"].map((family) => [family, validationCode(workflow, family, sources)]));
    const plan = await buildPlan({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
      tag: process.env.EVENT_TAG, force: process.env.FORCE_VALIDATION === "true",
      publication: process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.SUBMIT_REQUESTED === "true", logic });
    await prepare(plan, dir);
    const mac = plan.native.filter((p) => p.family === "homebrew" && !p.reuse);
    const windows = plan.native.find((p) => p.family === "winget");
    const outputs = { needed: plan.needed, submit: plan.submit, native: plan.assets.length > 0,
      homebrew: JSON.stringify({ include: mac }), winget: !!windows && !windows.reuse,
      winget_key: windows?.key ?? "" };
    for (let i = 0; i < 10; i++) outputs[`asset_${i}`] = plan.assets[i]?.key ?? "";
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT,
      Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { flag: "a" });
    console.log(JSON.stringify({ audit: plan.audit, needed: plan.needed, native: plan.native.map(({ runner, key, reuse, image }) => ({ runner, key, reuse, image })) }, null, 2));
  } else if (command === "asset") {
    await cachedAsset(JSON.parse(await readFile(resolve(dir, "plan.json"))), Number(index), dir);
  } else if (command === "verify") {
    const plan = JSON.parse(await readFile(resolve(dir, "plan.json")));
    // Only needed platform files are staged; verify each required checksum here.
    for (const { role, asset } of plan.assets) {
      const root = resolve(dir, "assets", role === "previous" ? "previous" : "");
      await verifyFile(resolve(root, asset.name), asset, asset.digest.slice(7));
    }
    const { checksumFor } = await import("./package-manager-release.mjs");
    for (const role of ["current", "previous"]) {
      const root = resolve(dir, "assets", role === "previous" ? "previous" : "");
      for (const { role: assetRole, asset } of plan.assets.filter(({ asset }) => /\.(dmg|exe)$/.test(asset.name))) {
        if (assetRole !== role) continue;
        const sums = await readFile(resolve(root, asset.name.endsWith(".exe") ? "PwrAgent-windows-SHA256SUMS" : "PwrAgent-macos-SHA256SUMS"), "utf8");
        await verifyFile(resolve(root, asset.name), asset, checksumFor(sums, asset.name));
      }
    }
  } else if (command === "record") {
    const plan = JSON.parse(await readFile(resolve(dir, "plan.json")));
    const platform = plan.native.find(({ runner }) => runner === index);
    await mkdir(".local/distribution-validation", { recursive: true });
    const eligible = imageMatches(process.env.ImageVersion, platform.image.version);
    if (eligible) await writeFile(".local/distribution-validation/success", JSON.stringify({ key: platform.key, image: process.env.ImageVersion }));
    else console.log(`Hosted image rollout differs (${process.env.ImageVersion} vs ${platform.image.version}); validated, but reuse disabled`);
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `reusable=${eligible}\n`, { flag: "a" });
  } else throw new Error("Use plan, asset, verify or record");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
