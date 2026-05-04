#!/usr/bin/env node
// Walks the packaged app.asar and fails the build if any forbidden file
// pattern slips into the bundle. Mirrors the exclusions in
// electron-builder.yml so a regression is caught loudly even if the YAML is
// edited carelessly.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const appPath = args[0]
  ?? resolve("release-stage/dist/mac-arm64/PwrAgent.app");

const asarPath = resolve(appPath, "Contents/Resources/app.asar");
if (!existsSync(asarPath)) {
  console.error(`verify-asar-contents: app.asar not found at ${asarPath}`);
  process.exit(1);
}

// @electron/asar is a transitive dependency of electron-builder, so it resolves
// from the desktop package's node_modules without an extra install step.
const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const listing = asar.listPackage(asarPath, { isPack: false });

// Each rule: [label, regex]. Anything matching → fail.
const forbidden = [
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
  ["Screenshot", /\.(png|jpg|jpeg|gif|tiff|psd|sketch|fig)$/i],
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

console.log(`verify-asar-contents: OK (${listing.length} entries, no forbidden patterns)`);
