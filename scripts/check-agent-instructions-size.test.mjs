import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AGENT_INSTRUCTION_LIMITS,
  CODEX_PROJECT_DOC_MAX_BYTES,
  DESKTOP_AGENTS_MD_MAX_BYTES,
  ROOT_AGENTS_MD_MAX_BYTES,
  checkAgentInstructionLimits,
  checkAgentInstructionsSize,
} from "./check-agent-instructions-size.mjs";

const CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES = 32 * 1024;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("checkAgentInstructionsSize", () => {
  it("keeps the limit under Codex's default project-doc budget", () => {
    expect(ROOT_AGENTS_MD_MAX_BYTES).toBeLessThan(
      CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES,
    );
  });

  it("passes exactly the sizes at or under the limit", () => {
    const limit = 100;
    for (let bytes = 0; bytes <= 2 * limit; bytes += 1) {
      const result = checkAgentInstructionsSize(bytes, limit);
      expect(result.ok).toBe(bytes <= limit);
      if (!result.ok) {
        expect(result.message).toContain(`${bytes - limit} over`);
      }
    }
  });

  it("rejects a file Codex would truncate", () => {
    expect(
      checkAgentInstructionsSize(CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES + 1).ok,
    ).toBe(false);
  });

  it("names the file or chain that is over", () => {
    const result = checkAgentInstructionsSize(11, 10, "apps/desktop/AGENTS.md");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^apps\/desktop\/AGENTS\.md is 11 bytes/);
  });
});

describe("checkAgentInstructionLimits", () => {
  it("guards the desktop file and the root + desktop chain Codex reads", () => {
    const byLabel = Object.fromEntries(
      AGENT_INSTRUCTION_LIMITS.map((limit) => [limit.label, limit]),
    );
    expect(byLabel["apps/desktop/AGENTS.md"]).toEqual({
      label: "apps/desktop/AGENTS.md",
      paths: ["apps/desktop/AGENTS.md"],
      maxBytes: DESKTOP_AGENTS_MD_MAX_BYTES,
    });
    expect(byLabel["AGENTS.md + apps/desktop/AGENTS.md"]).toEqual({
      label: "AGENTS.md + apps/desktop/AGENTS.md",
      paths: ["AGENTS.md", "apps/desktop/AGENTS.md"],
      maxBytes: CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES,
    });
    expect(CODEX_PROJECT_DOC_MAX_BYTES).toBe(
      CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES,
    );
  });

  // Oracle: a chain passes exactly when every file is within its own limit
  // and the sum of the chain is within Codex's budget.
  it("fails exactly when a file or the combined chain is over", () => {
    const limits = [
      { label: "root", paths: ["root"], maxBytes: 24 },
      { label: "desktop", paths: ["desktop"], maxBytes: 16 },
      { label: "chain", paths: ["root", "desktop"], maxBytes: 32 },
    ];
    for (let root = 0; root <= 30; root += 1) {
      for (let desktop = 0; desktop <= 20; desktop += 1) {
        const sizes = { root, desktop };
        const results = checkAgentInstructionLimits(
          (path) => sizes[path],
          limits,
        );
        expect(results.map((result) => result.ok)).toEqual([
          root <= 24,
          desktop <= 16,
          root + desktop <= 32,
        ]);
      }
    }
  });

  it("fails the chain when each file is under its own limit", () => {
    const sizes = {
      "AGENTS.md": ROOT_AGENTS_MD_MAX_BYTES,
      "apps/desktop/AGENTS.md": DESKTOP_AGENTS_MD_MAX_BYTES,
    };
    const results = checkAgentInstructionLimits((path) => sizes[path]);
    expect(results.map((result) => [result.label, result.ok])).toEqual([
      ["AGENTS.md", true],
      ["apps/desktop/AGENTS.md", true],
      ["AGENTS.md + apps/desktop/AGENTS.md", false],
    ]);
    expect(results[2].message).toContain(
      `${ROOT_AGENTS_MD_MAX_BYTES + DESKTOP_AGENTS_MD_MAX_BYTES
        - CODEX_PROJECT_DOC_MAX_BYTES} over`,
    );
  });

  it("passes for the checked-in instruction files", () => {
    const results = checkAgentInstructionLimits(
      (path) => readFileSync(join(repoRoot, path)).byteLength,
    );
    for (const result of results) {
      expect(result.message).toBeUndefined();
      expect(result.ok).toBe(true);
    }
  });
});
