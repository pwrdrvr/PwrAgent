#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.error(
    "Usage: RELEASE_TAG=v1.0.0-beta.1 node scripts/extract-release-notes.mjs --out /path/RELEASE_NOTES.md",
  );
  console.error(
    "   or: node scripts/extract-release-notes.mjs --tag v1.0.0-beta.1 --out /path/RELEASE_NOTES.md",
  );
}

function parseArgs(argv) {
  const options = {
    changelogPath: resolve(repoRoot, "CHANGELOG.md"),
    outPath: undefined,
    tag: process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      options.tag = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--tag=")) {
      options.tag = arg.slice("--tag=".length);
    } else if (arg === "--out") {
      options.outPath = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--out=")) {
      options.outPath = arg.slice("--out=".length);
    } else if (arg === "--changelog") {
      options.changelogPath = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--changelog=")) {
      options.changelogPath = arg.slice("--changelog=".length);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  return options;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function releaseVersionFromTag(tag) {
  if (!tag) {
    throw new Error("missing release tag");
  }
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function trimOuterBlankLines(lines) {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start].trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1].trim() === "") {
    end -= 1;
  }

  return lines.slice(start, end);
}

export function extractReleaseNotes(changelog, tag) {
  const version = releaseVersionFromTag(tag);
  const headingPattern = new RegExp(
    `^##\\s+v?${escapeRegex(version)}(?:\\s|$)`,
  );
  const lines = changelog.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => headingPattern.test(line));
  if (startIndex === -1) {
    return "";
  }

  const section = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line)) {
      break;
    }
    section.push(line);
  }

  const notes = trimOuterBlankLines(section).join("\n");
  return notes === "" ? "" : `${notes}\n`;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    throw error;
  }

  if (!options.tag || !options.outPath) {
    usage();
    process.exitCode = 1;
    return;
  }

  const changelog = readFileSync(options.changelogPath, "utf8");
  const notes = extractReleaseNotes(changelog, options.tag);
  writeFileSync(options.outPath, notes, "utf8");

  if (notes.trim() === "") {
    console.error(`No CHANGELOG.md notes found for ${options.tag}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
