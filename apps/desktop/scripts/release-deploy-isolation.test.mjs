import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps both release stages out of repeated paired pnpm deployments", () => {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !/pnpm\.(?:c?js|mjs)$/.test(pnpmCli)) {
    throw new Error("Run deployment isolation tests through pnpm test");
  }
  const root = mkdtempSync(join(tmpdir(), "pwragent-deploy-isolation-"));
  try {
    const desktop = join(root, "desktop");
    mkdirSync(desktop);
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - desktop\n");
    writeFileSync(join(desktop, "package.json"), JSON.stringify({
      name: "deploy-isolation-fixture",
      version: "1.0.0",
      private: true,
    }));
    cpSync(fileURLToPath(new URL("../.npmignore", import.meta.url)), join(desktop, ".npmignore"));
    writeFileSync(join(desktop, "runtime.js"), "export const ready = true;\n");
    const stages = ["release-stage", "release-stage-arm64"];
    for (const stage of stages) {
      mkdirSync(join(desktop, stage));
      writeFileSync(join(desktop, stage, "previous-build.txt"), "must not be deployed");
    }

    // Both preparation orders matter: the universal stage exists before the
    // arm64 stage in CI, and the arm64 stage survives into the next build.
    for (const stage of [...stages, ...stages]) {
      const target = join(desktop, stage);
      rmSync(target, { recursive: true, force: true });
      // Run the pinned pnpm JS entry directly; no Windows .cmd shell handoff.
      const result = spawnSync(process.execPath, [
        pnpmCli,
        "--filter", "deploy-isolation-fixture", "deploy", "--legacy",
        "--prod", "--offline", "--ignore-scripts", target,
      ], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(join(target, "runtime.js"), "utf8")).toContain("ready = true");
      for (const sibling of stages) {
        expect(existsSync(join(target, sibling))).toBe(false);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
