import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("keeps both release stages out of repeated paired pnpm deployments", () => {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !/pnpm-native(?:\.exe)?$/.test(pnpmCli)) {
    throw new Error("Run deployment isolation tests through pnpm test");
  }
  const root = mkdtempSync(join(tmpdir(), "pwragent-deploy-isolation-"));
  try {
    const desktop = join(root, "desktop");
    mkdirSync(desktop);
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
    cpSync(fileURLToPath(new URL("../../../patches/playwright@1.63.0.patch", import.meta.url)), join(root, "development.patch"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), [
      "packages:", "  - desktop", "globalPnpmfile: null",
      "patchedDependencies:", "  playwright@1.63.0: development.patch", "",
    ].join("\n"));
    writeFileSync(join(desktop, "package.json"), JSON.stringify({
      name: "deploy-isolation-fixture",
      version: "1.0.0",
      private: true,
      devDependencies: { playwright: "1.63.0" },
    }));
    // The patch is valid in a full workspace install; --prod excludes its
    // package from the deployed graph, which pnpm 12 otherwise rejects.
    const install = spawnSync(pnpmCli, ["install", "--offline", "--ignore-scripts"], {
      cwd: root, encoding: "utf8", timeout: 30_000,
    });
    expect(install.error).toBeUndefined();
    expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);
    expect(readFileSync(join(desktop, "node_modules/playwright/lib/worker/workerProcessEntry.js"), "utf8")).toContain("pwragent.playwrightShutdownDiagnostics");
    const release = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
    const deploySource = release.slice(release.indexOf("  const deployArgs = ["), release.indexOf("  step(`pnpm ${win"));
    cpSync(fileURLToPath(new URL("../.npmignore", import.meta.url)), join(desktop, ".npmignore"));
    writeFileSync(join(desktop, "runtime.js"), "export const ready = true;\n");
    const stages = ["release-stage", "release-stage-arm64"];
    mkdirSync(join(desktop, ".local", "debug-artifacts"), { recursive: true });
    writeFileSync(join(desktop, ".local", "debug-artifacts", "private-debug.tar.gz"), "outside the app");
    for (const stage of stages) {
      mkdirSync(join(desktop, stage));
      writeFileSync(join(desktop, stage, "previous-build.txt"), "must not be deployed");
    }

    // Both preparation orders matter: the universal stage exists before the
    // arm64 stage in CI, and the arm64 stage survives into the next build.
    for (const stage of [...stages, ...stages]) {
      const target = join(desktop, stage);
      rmSync(target, { recursive: true, force: true });
      // Run the pinned native executable directly; no Windows .cmd handoff.
      const args = runInNewContext(`${deploySource}\ndeployArgs`, {
        win: false, linux: true, macArch: "universal", stageDir: target,
      }).map((arg) => arg === "@pwragent/desktop" ? "deploy-isolation-fixture" : arg);
      const result = spawnSync(pnpmCli, [...args, "--offline", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(join(target, "runtime.js"), "utf8")).toContain("ready = true");
      expect(existsSync(join(target, ".local"))).toBe(false);
      expect(existsSync(join(target, "node_modules/playwright"))).toBe(false);
      for (const sibling of stages) {
        expect(existsSync(join(target, sibling))).toBe(false);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
