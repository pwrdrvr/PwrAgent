import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repository = fileURLToPath(new URL("../..", import.meta.url));

it("desktop-main setup preserves another run's Outpost dist", () => {
  const checkout = mkdtempSync(path.join(os.tmpdir(), "pwragent-outpost-bootstrap-"));
  try {
    const packageRoot = path.join(checkout, "packages/pwragent");
    const sentinel = path.join(packageRoot, "dist/other-run.txt");
    mkdirSync(path.dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, "another run's bundle\n");
    // Model the package builder's destructive first step without compiling
    // or staging native dependencies. Use the real Vitest config and setup.
    mkdirSync(path.join(packageRoot, "scripts"));
    writeFileSync(path.join(packageRoot, "scripts/build.mjs"), `
      import { rmSync } from "node:fs";
      rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
    `);

    const run = spawnSync(process.execPath, [
      path.join(repository, "node_modules/vitest/vitest.mjs"), "run",
      "--root", repository, "--config", path.join(repository, "vitest.workspace.mts"),
      "--project", "desktop-main", "--maxWorkers=1",
      "--testNamePattern", "lists only interactive project directories",
      "apps/desktop/src/main/__tests__/claude-session-reader.test.ts",
    ], { cwd: checkout, encoding: "utf8", timeout: 25_000 });

    expect(existsSync(sentinel), "desktop-main setup removed the Outpost dist sentinel").toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("another run's bundle\n");
    expect(run.error).toBeUndefined();
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}, 30_000);
