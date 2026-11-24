import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "darwin")("samples fresh and unchanged typechecks against distinct cache states", () => {
  const root = mkdtempSync(join(tmpdir(), "pwragent-check-benchmark-"));
  try {
    const bin = join(root, "bin");
    const output = join(root, "output");
    const revisions = ["baseline", "candidate"].map((name) => join(root, name));
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nprintf 'fixture\\n'\n", { mode: 0o755 });
    writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "typecheck") {
  const dir = "packages/consumer/node_modules/.cache/pwragent-typecheck";
  const info = dir + "/fixture.tsbuildinfo";
  console.log(fs.existsSync(info) ? "cached" : "fresh");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(info, "");
}
`, { mode: 0o755 });
    for (const revision of revisions) {
      mkdirSync(join(revision, "packages/consumer"), { recursive: true });
      writeFileSync(join(revision, "tsconfig.typecheck.json"), JSON.stringify({
        files: [], references: [{ path: "./packages/consumer" }],
      }));
    }
    const script = fileURLToPath(new URL("./benchmark-dev-checks.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, ...revisions, output], {
      encoding: "utf8",
      env: { ...process.env, PATH: [bin, process.env.PATH].join(delimiter), GITHUB_STEP_SUMMARY: "" },
      timeout: 12_000,
    });
    if (result.error) throw result.error;
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const { samples } = JSON.parse(readFileSync(join(output, "samples.json"), "utf8"));
    const typechecks = samples.filter(({ slice }) => slice.startsWith("typecheck"));
    expect(typechecks).toHaveLength(12);
    for (const { slice, variant, iteration } of typechecks) {
      const log = readFileSync(join(output, `${slice}-${variant}-${iteration}.log`), "utf8");
      expect(log.split("\n")[0]).toBe(slice === "typecheck-cold" ? "fresh" : "cached");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
