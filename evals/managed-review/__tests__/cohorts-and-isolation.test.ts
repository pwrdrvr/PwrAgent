import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { containsMachinePath } from "../drivers/cohort-data.mjs";
import {
  buildIsolatedEnv,
  resolveIsolationBackend,
} from "../drivers/isolated-sandbox.mjs";

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cohortsDir = path.join(suiteDir, "cohorts");
const driversDir = path.join(suiteDir, "drivers");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("managed-review cohorts, codex-native isolation, and prompt-override bundling", () => {
  it("preserves blinding flags, disjoint PR sets across splits, and zero machine paths", () => {
    const expected = [
      { file: "dev-1.json", blind: false },
      { file: "dev-2.json", blind: false },
      { file: "test-1.json", blind: true },
      { file: "test-2.json", blind: true },
    ];
    const seenPrs = new Set<number>();
    for (const { file, blind } of expected) {
      const parsed = JSON.parse(fs.readFileSync(path.join(cohortsDir, file), "utf8"));
      expect(Boolean(parsed.blind)).toBe(blind);
      expect(Array.isArray(parsed.cases)).toBe(true);
      expect(parsed.cases.length).toBeGreaterThan(0);
      expect(containsMachinePath(parsed)).toBe(false);
      for (const c of parsed.cases) {
        expect(seenPrs.has(c.pr)).toBe(false);
        seenPrs.add(c.pr);
      }
    }
  });

  it("treats codex-native identically to codex for OS isolation selection and env wiring", () => {
    expect(resolveIsolationBackend({ requested: "codex-sandbox", arm: "codex-native", platform: "darwin" }))
      .toBe("codex-sandbox");
    expect(resolveIsolationBackend({ requested: "codex-sandbox", arm: "codex-native", platform: "linux" }))
      .toBe("codex-sandbox");
    expect(() => resolveIsolationBackend({ requested: "codex-sandbox", arm: "neon", platform: "darwin" }))
      .toThrow(/applies only to codex arms/i);
    const env = buildIsolatedEnv({
      arm: "codex-native",
      cellRoot: "/tmp/cell-x",
      pwragentHome: "/tmp/cell-x/pwragent-home",
      runnerHome: "/tmp/cell-x/home",
      codexHome: "/tmp/cell-x/codex-home",
      restrictedBinDir: "/tmp/cell-x/bin",
      createTmpDir: false,
    });
    expect(env.CODEX_HOME).toBe("/tmp/cell-x/codex-home");
  });

  it("injects --prompt-file into bundled drivers without mutating source files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-eval-prompt-bundle-"));
    tempDirs.push(tmp);
    const sentinel = "SENTINEL_EVAL_PROMPT_OVERRIDE_V1";
    const promptPath = path.join(tmp, "variant.md");
    const distDir = path.join(tmp, "dist");
    fs.writeFileSync(promptPath, `# Custom Variant\n\n${sentinel}\n`);

    const built = spawnSync(process.execPath, [
      path.join(driversDir, "build-driver.mjs"),
      "--out", distDir,
      "--prompt-file", promptPath,
    ], { encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);

    const devBundle = fs.readFileSync(path.join(distDir, "review-matrix-driver.js"), "utf8");
    const isoBundle = fs.readFileSync(path.join(distDir, "isolated", "isolated-review-runner.js"), "utf8");
    expect(devBundle).toContain(sentinel);
    expect(isoBundle).toContain(sentinel);
  });
});
