import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
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

// An instruction file somewhere in a small tree, so generated paths share
// ancestors and name prefixes (`a` beside `ab`).
const instructionPath = fc
  .tuple(
    fc.array(fc.constantFrom("apps", "desktop", "a", "ab", "src"), {
      maxLength: 4,
    }),
    fc.constantFrom("AGENTS.md", "AGENTS.override.md"),
  )
  .map(([dirs, name]) => [...dirs, name].join("/"));

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
  // Oracle: for the root and each ancestor of the file's directory, shallowest
  // first, Codex reads that directory's AGENTS.override.md if it exists, else
  // its AGENTS.md.
  function oracleChain(file, files) {
    const dirs = file.split("/").slice(0, -1);
    const chain = [];
    for (let depth = 0; depth <= dirs.length; depth += 1) {
      const prefix = dirs.slice(0, depth);
      const pick = ["AGENTS.override.md", "AGENTS.md"]
        .map((name) => [...prefix, name].join("/"))
        .find((candidate) => files.includes(candidate));
      if (pick) chain.push(pick);
    }
    return chain;
  }

  it("matches the ancestor oracle", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(instructionPath, { minLength: 1, maxLength: 12 }),
        (files) => {
          for (const file of files) {
            expect(agentInstructionChain(file, files)).toEqual(
              oracleChain(file, files),
            );
          }
        },
      ),
    );
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

  it("reads a directory's AGENTS.override.md in place of its AGENTS.md", () => {
    expect(
      agentInstructionChain("apps/desktop/AGENTS.md", [
        "AGENTS.md",
        "apps/desktop/AGENTS.md",
        "apps/desktop/AGENTS.override.md",
      ]),
    ).toEqual(["AGENTS.md", "apps/desktop/AGENTS.override.md"]);
  });
});

describe("checkAgentInstructionLimits", () => {
  it("checks the root and desktop files and every nested chain once", () => {
    const limits = agentInstructionLimits([
      "AGENTS.md",
      "apps/desktop/AGENTS.md",
      "apps/desktop/src/main/claude/AGENTS.md",
      "apps/desktop/src/main/claude/AGENTS.override.md",
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
          + " + apps/desktop/src/main/claude/AGENTS.override.md",
        paths: [
          "AGENTS.md",
          "apps/desktop/AGENTS.md",
          "apps/desktop/src/main/claude/AGENTS.override.md",
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
  // own limit, or some nested file's chain sums past Codex's budget. Sizes
  // range past every limit so each bound is crossed.
  it("fails exactly when a file or any chain is over", () => {
    const nested = [
      "apps/desktop/src/main/claude/AGENTS.md",
      "apps/desktop/src/renderer/src/features/update/AGENTS.md",
    ];
    const files = [
      "AGENTS.md",
      "apps/desktop/AGENTS.md",
      ...nested,
      "packages/messaging/AGENTS.md",
    ];
    const limits = agentInstructionLimits(files);
    const size = fc.integer({ min: 0, max: 26 * 1024 });
    fc.assert(
      fc.property(fc.tuple(...files.map(() => size)), (values) => {
        const sizes = Object.fromEntries(
          files.map((file, index) => [file, values[index]]),
        );
        const root = sizes["AGENTS.md"];
        const desktop = sizes["apps/desktop/AGENTS.md"];
        const chains = [
          root + desktop,
          ...nested.map((file) => root + desktop + sizes[file]),
          root + sizes["packages/messaging/AGENTS.md"],
        ];
        const expected =
          root <= ROOT_AGENTS_MD_MAX_BYTES
          && desktop <= DESKTOP_AGENTS_MD_MAX_BYTES
          && chains.every((bytes) => bytes <= CODEX_PROJECT_DOC_MAX_BYTES);
        const results = checkAgentInstructionLimits(
          (path) => sizes[path],
          limits,
        );
        expect(results.every((result) => result.ok)).toBe(expected);
      }),
    );
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

describe("listAgentInstructionFiles", () => {
  // Oracle: real git in a temporary repository owned by the test.
  it("lists untracked files and skips tracked files deleted locally", () => {
    const repo = mkdtempSync(join(tmpdir(), "agent-instructions-"));
    try {
      const git = (...args) =>
        execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      git("init", "-q");
      const write = (path) => {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), "rules\n");
      };
      write("AGENTS.md");
      write("a/AGENTS.md");
      write("b/AGENTS.md");
      // Keep the fixtures LF and let Git reject any irreversible conversion.
      git("-c", "core.autocrlf=false", "-c", "core.safecrlf=true", "add", ".");
      git(
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-q",
        "-m",
        "seed",
      );
      write("a/new/AGENTS.md");
      write("a/AGENTS.override.md");
      write("ignored/AGENTS.md");
      writeFileSync(join(repo, ".gitignore"), "ignored/\n");
      rmSync(join(repo, "b/AGENTS.md"));
      expect(listAgentInstructionFiles(repo)).toEqual([
        "AGENTS.md",
        "a/AGENTS.md",
        "a/AGENTS.override.md",
        "a/new/AGENTS.md",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
