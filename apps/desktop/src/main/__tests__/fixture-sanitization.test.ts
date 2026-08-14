import { readdir, readFile } from "node:fs/promises";
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
        const source = (await readFile(filePath, "utf8")).toLowerCase();
        for (const term of retiredFixtureTerms) {
          if (source.includes(term)) {
            violations.push(`${path.relative(repoRoot, filePath)}: ${term}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
