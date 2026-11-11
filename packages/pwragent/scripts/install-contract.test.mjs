import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("postinstall needs no sparse-excluded files until the package has its runtime manifest", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const root = mkdtempSync(path.join(os.tmpdir(), "outpost-install-contract-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    const run = () => spawnSync(pkg.scripts.postinstall, { cwd: root, shell: true, encoding: "utf8" });
    const sparse = run();
    assert.equal(sparse.status, 0, sparse.stderr);
    assert.equal(existsSync(path.join(root, "scripts")), false);
    mkdirSync(path.join(root, "dist")); mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "dist/runtime.json"), "{}");
    writeFileSync(path.join(root, "scripts/install.mjs"), 'import fs from "node:fs"; fs.writeFileSync("installer-ran", "yes");');
    const packed = run();
    assert.equal(packed.status, 0, packed.stderr);
    assert.equal(readFileSync(path.join(root, "installer-ran"), "utf8"), "yes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
