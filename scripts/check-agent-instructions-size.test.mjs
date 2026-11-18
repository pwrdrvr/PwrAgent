import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CODEX_PROJECT_DOC_MAX_BYTES,
  DESKTOP_AGENTS_MD_MAX_BYTES,
  ROOT_AGENTS_MD_MAX_BYTES,
  agentInstructionChain,
  agentInstructionLimits,
  checkAgentInstructionLimits,
  checkAgentInstructionsSize,
  listAgentInstructionFiles,
} from "./check-agent-instructions-size.mjs";

const CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES = 32 * 1024;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Deterministic PRNG so a failing sweep reproduces.
function mulberry32(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("checkAgentInstructionsSize", () => {
  it("keeps the limit under Codex's default project-doc budget", () => {
    expect(ROOT_AGENTS_MD_MAX_BYTES).toBeLessThan(
      CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES,
    );
    expect(CODEX_PROJECT_DOC_MAX_BYTES).toBe(
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

describe("agentInstructionChain", () => {
  // Oracle: a file is in the chain exactly when its directory is the root or
  // an ancestor of (or equal to) the nested file's directory, ordered by depth.
  function oracleChain(file, files) {
    const dir = file.split("/").slice(0, -1);
    return files
      .map((candidate) => candidate.split("/").slice(0, -1))
      .filter((cdir) => cdir.every((part, index) => dir[index] === part))
      .filter((cdir) => cdir.length <= dir.length)
      .sort((a, b) => a.length - b.length)
      .map((cdir) => [...cdir, "AGENTS.md"].join("/"));
  }

  it("matches the ancestor oracle for random trees", () => {
    const random = mulberry32(3920);
    const names = ["apps", "desktop", "src", "a", "ab", "b", "main"];
    for (let run = 0; run < 300; run += 1) {
      const files = new Set(["AGENTS.md"]);
      const count = 1 + Math.floor(random() * 6);
      for (let index = 0; index < count; index += 1) {
        const depth = 1 + Math.floor(random() * 4);
        const parts = Array.from(
          { length: depth },
          () => names[Math.floor(random() * names.length)],
        );
        files.add([...parts, "AGENTS.md"].join("/"));
      }
      const list = [...files];
      for (const file of list) {
        expect(agentInstructionChain(file, list)).toEqual(
          oracleChain(file, list),
        );
      }
    }
  });

  it("does not treat a sibling with a shared name prefix as an ancestor", () => {
    expect(
      agentInstructionChain("apps/desktop-x/AGENTS.md", [
        "AGENTS.md",
        "apps/desktop/AGENTS.md",
        "apps/desktop-x/AGENTS.md",
      ]),
    ).toEqual(["AGENTS.md", "apps/desktop-x/AGENTS.md"]);
  });
});

describe("checkAgentInstructionLimits", () => {
  it("checks the root and desktop files and every nested chain", () => {
    const limits = agentInstructionLimits([
      "AGENTS.md",
      "apps/desktop/AGENTS.md",
      "apps/desktop/src/main/claude/AGENTS.md",
      "packages/shared/AGENTS.md",
    ]);
    expect(limits).toEqual([
      {
        label: "AGENTS.md",
        paths: ["AGENTS.md"],
        maxBytes: ROOT_AGENTS_MD_MAX_BYTES,
      },
      {
        label: "apps/desktop/AGENTS.md",
        paths: ["apps/desktop/AGENTS.md"],
        maxBytes: DESKTOP_AGENTS_MD_MAX_BYTES,
      },
      {
        label: "AGENTS.md + apps/desktop/AGENTS.md",
        paths: ["AGENTS.md", "apps/desktop/AGENTS.md"],
        maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
      },
      {
        label:
          "AGENTS.md + apps/desktop/AGENTS.md"
          + " + apps/desktop/src/main/claude/AGENTS.md",
        paths: [
          "AGENTS.md",
          "apps/desktop/AGENTS.md",
          "apps/desktop/src/main/claude/AGENTS.md",
        ],
        maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
      },
      {
        label: "AGENTS.md + packages/shared/AGENTS.md",
        paths: ["AGENTS.md", "packages/shared/AGENTS.md"],
        maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
      },
    ]);
  });

  // Oracle: the check fails exactly when the root or desktop file is over its
  // own limit, or some nested file's chain sums past Codex's budget.
  it("fails exactly when a file or any chain is over", () => {
    const random = mulberry32(32768);
    const files = [
      "AGENTS.md",
      "apps/desktop/AGENTS.md",
      "apps/desktop/src/main/claude/AGENTS.md",
      "apps/desktop/src/renderer/src/features/update/AGENTS.md",
      "packages/messaging/AGENTS.md",
    ];
    const limits = agentInstructionLimits(files);
    for (let run = 0; run < 500; run += 1) {
      const sizes = Object.fromEntries(
        files.map((file) => [file, Math.floor(random() * 20 * 1024)]),
      );
      const results = checkAgentInstructionLimits(
        (path) => sizes[path],
        limits,
      );
      const root = sizes["AGENTS.md"];
      const desktop = sizes["apps/desktop/AGENTS.md"];
      const expected =
        root <= ROOT_AGENTS_MD_MAX_BYTES
        && desktop <= DESKTOP_AGENTS_MD_MAX_BYTES
        && root + desktop <= CODEX_PROJECT_DOC_MAX_BYTES
        && root + desktop + sizes["apps/desktop/src/main/claude/AGENTS.md"]
          <= CODEX_PROJECT_DOC_MAX_BYTES
        && root + desktop
          + sizes["apps/desktop/src/renderer/src/features/update/AGENTS.md"]
          <= CODEX_PROJECT_DOC_MAX_BYTES
        && root + sizes["packages/messaging/AGENTS.md"]
          <= CODEX_PROJECT_DOC_MAX_BYTES;
      expect(results.every((result) => result.ok)).toBe(expected);
    }
  });

  it("fails a chain when each file is under its own limit", () => {
    const sizes = {
      "AGENTS.md": ROOT_AGENTS_MD_MAX_BYTES,
      "apps/desktop/AGENTS.md": DESKTOP_AGENTS_MD_MAX_BYTES,
    };
    const results = checkAgentInstructionLimits(
      (path) => sizes[path],
      agentInstructionLimits(Object.keys(sizes)),
    );
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
    const files = listAgentInstructionFiles(repoRoot);
    expect(files).toContain("AGENTS.md");
    expect(files).toContain("apps/desktop/AGENTS.md");
    const results = checkAgentInstructionLimits(
      (path) => readFileSync(join(repoRoot, path)).byteLength,
      agentInstructionLimits(files),
    );
    for (const result of results) {
      expect(result.message).toBeUndefined();
      expect(result.ok).toBe(true);
    }
  });
});
