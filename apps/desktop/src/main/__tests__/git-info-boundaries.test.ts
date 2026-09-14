import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const config = require("../../../../../.dependency-cruiser.cjs");
const executable = path.resolve("node_modules/dependency-cruiser/bin/dependency-cruise.mjs");
const run = promisify(execFile);

describe("Git dependency boundaries", () => {
  it("rejects static, dynamic and re-export bypasses while allowing the store route", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-git-boundaries-"));
    try {
      const files: Record<string, string> = {
        "apps/desktop/src/renderer/process.ts": 'import { spawn } from "node:child_process"; export { spawn };',
        "apps/desktop/src/renderer/dugite.ts": 'export * from "dugite";',
        "apps/desktop/src/renderer/dynamic.ts": 'export const git = () => import("simple-git");',
        "apps/desktop/src/renderer/transitive.ts": 'export * from "../shared/unsafe-git";',
        "apps/desktop/src/shared/unsafe-git.ts": 'export * from "node:child_process";',
        "apps/desktop/src/renderer/main.ts": 'export * from "../main/git-info/directory-store";',
        "apps/desktop/src/main/ipc/bypass.ts": 'export * from "../git-info/private/probe";',
        "apps/desktop/src/main/ipc/allowed.ts": 'export * from "../git-info/directory-store";',
        "apps/desktop/src/main/git-info/directory-store.ts": 'export * from "./private/probe";',
        "apps/desktop/src/main/git-info/private/probe.ts": 'export const probe = 1;',
        "apps/desktop/src/main/git-info/read-cache.ts": 'import { stat } from "node:fs/promises"; export { stat };',
      };
      for (const [file, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), content);
      }
      await writeFile(path.join(root, "tsconfig.base.json"), "{}");
      await writeFile(path.join(root, "rules.cjs"), `module.exports = ${JSON.stringify(config)};`);
      const result = await run(process.execPath, [executable, "--config", "rules.cjs", "--output-type", "json", "apps/desktop/src/"], {
        cwd: root, maxBuffer: 1_000_000,
      }).catch((error: { stdout: string }) => ({ stdout: error.stdout }));
      const violations = JSON.parse(result.stdout).summary.violations as Array<{
        from: string; rule: { name: string };
      }>;
      expect([...new Set(violations.map(({ from, rule }) => `${from}:${rule.name}`))].sort()).toEqual([
        ["apps/desktop/src/renderer/transitive.ts", "desktop-ui-has-no-native-git-access"],
        ["apps/desktop/src/renderer/process.ts", "desktop-ui-has-no-native-git-access"],
        ["apps/desktop/src/renderer/dugite.ts", "desktop-ui-has-no-native-git-access"],
        ["apps/desktop/src/renderer/dynamic.ts", "desktop-ui-has-no-native-git-access"],
        ["apps/desktop/src/renderer/main.ts", "desktop-ui-has-no-native-git-access"],
        ["apps/desktop/src/main/ipc/bypass.ts", "desktop-git-probes-are-store-private"],
        ["apps/desktop/src/main/git-info/read-cache.ts", "desktop-git-cache-policy-has-no-io"],
      ].map(([from, rule]) => `${from}:${rule}`).sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
