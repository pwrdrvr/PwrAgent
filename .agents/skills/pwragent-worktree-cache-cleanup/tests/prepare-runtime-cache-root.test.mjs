import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const helper = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../scripts/prepare-electron-runtime.mjs"), "utf8");

for (const choice of ["default", "empty", "isolated", "explicit"]) {
  test(`cache selection respects ${choice} root`, () => {
    const root = mkdtempSync(join(tmpdir(), "pwragent-cache-root-"));
    try {
      const fakeHome = join(root, "operator home");
      const isolated = join(root, "isolated profile");
      const explicit = join(root, "explicit cache");
      const electron = join(root, "electron");
      mkdirSync(join(electron, "node_modules/@electron/get"), { recursive: true });
      writeFileSync(join(electron, "package.json"), JSON.stringify({ name: "electron", version: "44.10.1" }));
      writeFileSync(join(electron, "checksums.json"), JSON.stringify({ "electron-v44.10.1-darwin-arm64.zip": "fixture-checksum" }));
      writeFileSync(join(electron, "node_modules/@electron/get/index.js"), "exports.downloadArtifact = () => { throw new Error('Network forbidden'); };");
      // Execute the real helper, substituting only its installer boundary.
      // Every possible write stays under this fixture's fake HOME.
      const installer = `
        import { mkdirSync, writeFileSync } from "node:fs";
        async function ensureRuntime(options) {
          if (!options.cacheRoot.startsWith(${JSON.stringify(root + "/")})) throw new Error("Write escaped fixture");
          const identity = { format: 1, version: options.version, platform: options.platform,
            arch: options.arch, checksum: options.expectedChecksum };
          const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
          const cache = join(options.cacheRoot, key);
          mkdirSync(cache, { recursive: true });
          writeFileSync(join(cache, "runtime.json"), JSON.stringify({ identity }));
        }
      `;
      const source = helper.replace(/import \{ ensureRuntime \} from [^\n]+;/, installer);
      assert.notEqual(source, helper, "The installer boundary must be stubbed");
      const entry = `process.argv = [process.execPath, "fixture", ...process.argv.slice(1)];\nawait import(${JSON.stringify("data:text/javascript;base64," + Buffer.from(source).toString("base64"))});`;
      const env = { ...process.env, HOME: fakeHome };
      delete env.PWRAGENT_HOME;
      if (choice === "empty") env.PWRAGENT_HOME = "";
      if (["isolated", "explicit"].includes(choice)) env.PWRAGENT_HOME = isolated;
      const args = ["--input-type=module", "-e", entry, electron, "arm64"];
      if (choice === "explicit") args.push(explicit);
      const result = JSON.parse(execFileSync(process.execPath, args, { env, encoding: "utf8" }));
      const expected = choice === "explicit" ? explicit
        : join(choice === "isolated" ? isolated : join(fakeHome, ".pwragent"), "cache/electron-runtime/v1");
      assert.equal(dirname(result.cache), expected);
      if (["isolated", "explicit"].includes(choice)) assert.equal(existsSync(join(fakeHome, ".pwragent")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
