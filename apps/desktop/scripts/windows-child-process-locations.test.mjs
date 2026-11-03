import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childProcessLocations } from "./windows-child-process-locations.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(source) {
  const root = mkdtempSync(path.join(os.tmpdir(), "child-locations-"));
  roots.push(root);
  const main = path.join(root, "out", "main");
  mkdirSync(main, { recursive: true });
  writeFileSync(path.join(main, "index.js"), "f();");
  writeFileSync(path.join(main, "index.js.map"), JSON.stringify({
    version: 3, sources: [source], names: [], mappings: "AAAA", sourcesContent: ["PRIVATE_SOURCE_CONTENT"],
  }));
  const journal = path.join(root, "children.jsonl");
  const callSites = [{ file: "out/main/index.js", line: 1, column: 1 }];
  writeFileSync(journal, JSON.stringify({ callSites: [...callSites, ...callSites] }) + "\n");
  return { root, journal };
}

describe("deferred child process call-site resolution", () => {
  it("joins minified locations to app source with matching bundle/map hashes", () => {
    const { root, journal } = fixture("../../src/main/settings/command-discovery.ts");
    const report = childProcessLocations(root, journal);
    expect(report.locations).toEqual([{ file: "out/main/index.js", line: 1, column: 1, status: "mapped",
      source: "src/main/settings/command-discovery.ts", sourceLine: 1, sourceColumn: 1 }]);
    expect(report.builds[0].scriptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.builds[0].mapSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.journalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_SOURCE_CONTENT");
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it("does not retain private or dependency source paths", () => {
    const { root, journal } = fixture("/private/operator/secret.ts");
    const report = childProcessLocations(root, journal);
    expect(report.locations[0].status).toBe("unmapped");
    expect(JSON.stringify(report)).not.toMatch(/operator|secret|PRIVATE_SOURCE/);
  });

  it("reports unavailable journals without leaking filesystem errors", () => {
    expect(childProcessLocations("/private/operator", "/private/operator/missing")).toEqual({
      status: "journal-unavailable", builds: [], locations: [],
    });
  });
});
