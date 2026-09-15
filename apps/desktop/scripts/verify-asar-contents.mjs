#!/usr/bin/env node
// Walks the packaged app.asar and fails the build if any forbidden file
// pattern slips into the bundle. Mirrors the exclusions in
// electron-builder.yml so a regression is caught loudly even if the YAML is
// edited carelessly.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  missingPackagedRuntimeFiles,
  normalizeAsarListing,
  requiredPackagedRuntimeFiles,
} from "./asar-entry-paths.mjs";
import { findRemoteScript, isRendererHtmlEntry } from "./packaged-html-rules.mjs";

const args = process.argv.slice(2);
const appPath = args[0]
  ?? resolve("release-stage/dist/mac-universal/PwrAgent.app");

function resolveAsarPath(path) {
  const directAsarPath = resolve(path);
  if (directAsarPath.endsWith(".asar") && existsSync(directAsarPath)) {
    return directAsarPath;
  }

  const macAsarPath = resolve(path, "Contents/Resources/app.asar");
  if (existsSync(macAsarPath)) {
    return macAsarPath;
  }

  const linuxAsarPath = resolve(path, "resources/app.asar");
  if (existsSync(linuxAsarPath)) {
    return linuxAsarPath;
  }

  return macAsarPath;
}

const asarPath = resolveAsarPath(appPath);
if (!existsSync(asarPath)) {
  console.error(`verify-asar-contents: app.asar not found at ${asarPath}`);
  process.exit(1);
}

// @electron/asar is a transitive dependency of electron-builder. The protected
// Windows signing job receives a self-contained staged toolchain rather than
// the workspace node_modules, so allow release.mjs to resolve from that stage
// without reinstalling dependencies around signing credentials.
const asarModuleRoot = process.env.PWRAGENT_ASAR_MODULE_ROOT?.trim();
const require = asarModuleRoot
  ? createRequire(resolve(asarModuleRoot, "package.json"))
  : createRequire(import.meta.url);
const asar = require("@electron/asar");
const listing = normalizeAsarListing(
  asar.listPackage(asarPath, { isPack: false }),
);
const missingRuntimeFiles = missingPackagedRuntimeFiles(
  listing,
  process.platform,
  process.arch,
);
for (const runtimeFile of requiredPackagedRuntimeFiles(
  process.platform,
  process.arch,
)) {
  if (
    !runtimeFile.unpacked
    || missingRuntimeFiles.some(({ entry }) => entry === runtimeFile.entry)
  ) {
    continue;
  }
  const unpackedPath = join(
    `${asarPath}.unpacked`,
    ...runtimeFile.entry.slice(1).split("/"),
  );
  if (!existsSync(unpackedPath)) {
    missingRuntimeFiles.push({
      ...runtimeFile,
      unpackedPath,
    });
  }
}

if (missingRuntimeFiles.length > 0) {
  console.error("\nverify-asar-contents: required packaged runtime files are missing\n");
  for (const runtimeFile of missingRuntimeFiles) {
    console.error(`  ${runtimeFile.entry}`);
    if (runtimeFile.unpackedPath) {
      console.error(`    expected unpacked file at ${runtimeFile.unpackedPath}`);
    }
  }
  console.error(
    "\nKeep platform-native optional dependencies explicit in apps/desktop/package.json.",
  );
  process.exit(1);
}
// Each rule: [label, regex]. Anything matching → fail.
const forbidden = [
  ["SQLite build source", /\/node_modules\/better-sqlite3\/deps\/sqlite3\/[^/]+\.[ch]$/],
  ["TypeScript source", /\.tsx?$/],
  ["TypeScript declaration", /\.d\.ts$/],
  ["Sourcemap", /\.map$/],
  ["tsconfig", /(^|\/)tsconfig.*\.json$/],
  ["Test file", /\.(test|spec)\.[cm]?[jt]sx?$/],
  ["__tests__ dir", /\/__tests__\//],
  ["e2e dir", /\/e2e\//],
  ["Markdown", /\.mdx?$/],
  ["docs dir", /\/docs\//],
  ["Env example", /\/\.env(\.|$)/],
  ["Workspace src/ leak", /\/node_modules\/@pwragent\/[^/]+\/src\//],
  ["Workspace AGENTS.md", /\/node_modules\/@pwragent\/[^/]+\/AGENTS\.md$/],
  [
    "Screenshot/design image",
    /(^|\/)[^/]*(screenshot|screenie|capture|mockup|wireframe|prototype|design)[^/]*\.(png|jpg|jpeg|gif|tiff|psd|sketch|fig)$/i,
  ],
  ["Playwright config", /playwright\.config\./],
  ["Project plan/brainstorm", /\/(plans|brainstorms|design)\//],
];

const violations = [];
for (const entry of listing) {
  for (const [label, pattern] of forbidden) {
    if (pattern.test(entry)) {
      violations.push({ label, entry });
      break;
    }
  }
}

if (violations.length > 0) {
  const grouped = new Map();
  for (const { label, entry } of violations) {
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(entry);
  }
  console.error(`\nverify-asar-contents: ${violations.length} forbidden file(s) in app.asar\n`);
  for (const [label, entries] of grouped) {
    console.error(`  [${label}] ${entries.length} match(es):`);
    for (const e of entries.slice(0, 5)) console.error(`    ${e}`);
    if (entries.length > 5) console.error(`    … and ${entries.length - 5} more`);
  }
  console.error(`\nUpdate apps/desktop/electron-builder.yml \`files:\` exclusions to drop these.`);
  process.exit(1);
}

// A packaged renderer must load every script from inside the asar. The one
// thing that has ever wanted to break that rule is the dev-only React
// DevTools bridge (PWRAGENT_DEV_REACT_DEVTOOLS), which injects
// `<script src="http://localhost:8097">` as the first head script at Vite
// config time. That is a build-time decision, so nothing at app runtime can
// undo it — this is where it gets caught. The rule is written against the
// shape, not against the flag, so any remote script trips it.
//
// An entry that cannot be read fails the gate rather than being skipped. This
// is a check whose whole job is to stop something shipping, so "could not look"
// has to be as loud as "looked and found it" — a silent skip would let the
// exact file the gate exists for pass unexamined.
const remoteScriptViolations = [];
const unreadableHtmlEntries = [];
for (const entry of listing.filter(isRendererHtmlEntry)) {
  let contents;
  try {
    // Listings use forward slashes for matching; ASAR lookup uses path.sep.
    const extractionPath = join(...entry.replace(/^\//, "").split("/"));
    contents = asar.extractFile(asarPath, extractionPath).toString("utf8");
  } catch (error) {
    unreadableHtmlEntries.push({ entry, reason: error?.message ?? String(error) });
    continue;
  }
  const snippet = findRemoteScript(contents);
  if (snippet) {
    remoteScriptViolations.push({ entry, snippet });
  }
}

if (remoteScriptViolations.length > 0 || unreadableHtmlEntries.length > 0) {
  if (remoteScriptViolations.length > 0) {
    console.error(
      `\nverify-asar-contents: ${remoteScriptViolations.length} packaged HTML file(s) load a remote script\n`,
    );
    for (const { entry, snippet } of remoteScriptViolations) {
      console.error(`  ${entry}`);
      console.error(`    ${snippet}`);
    }
    console.error(
      "\nBuild without PWRAGENT_DEV_REACT_DEVTOOLS set. That bridge is for local"
      + "\nprofiling builds only and must never reach a packaged app.",
    );
  }
  if (unreadableHtmlEntries.length > 0) {
    console.error(
      `\nverify-asar-contents: ${unreadableHtmlEntries.length} packaged HTML file(s) could not be read\n`,
    );
    for (const { entry, reason } of unreadableHtmlEntries) {
      console.error(`  ${entry}`);
      console.error(`    ${reason}`);
    }
    console.error(
      "\nThese were not inspected for remote scripts, so the bundle is not cleared."
      + "\nA renderer HTML entry should be a readable, packed file.",
    );
  }
  process.exit(1);
}

console.log(
  `verify-asar-contents: OK (${listing.length} entries, required runtime files present, no forbidden patterns, no remote scripts)`,
);
