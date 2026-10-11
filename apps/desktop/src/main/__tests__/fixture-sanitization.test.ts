import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const activeSourceRoots = [
  path.join(repoRoot, "apps", "desktop", "src"),
  path.join(repoRoot, "apps", "desktop", "e2e"),
  path.join(repoRoot, "packages"),
];
const textExtensions = new Set([
  ".cjs",
  ".json",
  ".jsonl",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const ignoredDirectories = new Set([
  ".local",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const retiredFixtureTerms = [
  ["gi", "phy"].join(""),
  ["gif", "grabber"].join(""),
  ["search", "grpc"].join(""),
  ["search", "-external"].join(""),
  ["search", "external"].join(""),
  ["search", "-compare"].join(""),
  ["search", "compare"].join(""),
  ["search", "-product"].join(""),
  ["search", "product"].join(""),
  ["gif", "-recommendations"].join(""),
  ["gif", "recommendations"].join(""),
  ["example", "-services"].join(""),
  ["example", "services"].join(""),
  ["spectrum", "db"].join(""),
  ["search", "-4803"].join(""),
];
// One case-insensitive pass per file. The scan covers every source file; an
// awaited read, a UTF-8 decode, a lowercased copy, and a scan per term for
// every file is work that a loaded full run stretches past the default timeout.
const retiredFixturePattern = new RegExp(
  retiredFixtureTerms
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "i",
);

async function listTextFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name)
        ? []
        : await listTextFiles(entryPath);
    }
    return entry.isFile() && textExtensions.has(path.extname(entry.name))
      ? [entryPath]
      : [];
  }));
  return nested.flat();
}

describe("active fixture samples", () => {
  it("keep retired sample identifiers out of source and replay data", async () => {
    const violations: string[] = [];
    for (const sourceRoot of activeSourceRoots) {
      for (const filePath of await listTextFiles(sourceRoot)) {
        // The terms are ASCII, so latin1 matches them byte for byte in UTF-8
        // text without paying for a UTF-8 decode.
        const source = readFileSync(filePath, "latin1");
        if (!retiredFixturePattern.test(source)) {
          continue;
        }
        const lowered = source.toLowerCase();
        for (const term of retiredFixtureTerms) {
          if (lowered.includes(term)) {
            violations.push(`${path.relative(repoRoot, filePath)}: ${term}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
