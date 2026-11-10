import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const roots = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pwragent-electron-cache-"));
  roots.push(root);
  const payload = join(root, "payload");
  mkdirSync(join(payload, "Electron.app/Contents/MacOS"), { recursive: true });
  writeFileSync(join(payload, "Electron.app/Contents/MacOS/Electron"), randomBytes(1024 * 1024), { mode: 0o755 });
  writeFileSync(join(payload, "version"), "44.10.1");
  writeFileSync(join(payload, "electron.d.ts"), "// fixture types\n");
  const zip = join(root, "electron.zip");
  execFileSync("zip", ["-q", "-r", zip, "."], { cwd: payload });
  return { root, zip };
}

function installAt({ root, zip }, name) {
  const target = join(root, name);
  const electron = join(target, "node_modules/electron");
  mkdirSync(join(electron, "node_modules/@electron/get"), { recursive: true });
  // Copy the actual entry point so its createRequire resolves our disposable
  // package. No production dependency or user's cache is changed by the test.
  cpSync(join(here, "ensure-electron-runtime.mjs"), join(target, "install.mjs"));
  const helper = join(here, "electron-runtime-cache.mjs");
  try { cpSync(helper, join(target, "electron-runtime-cache.mjs")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writeFileSync(join(electron, "package.json"), JSON.stringify({ name: "electron", version: "44.10.1" }));
  writeFileSync(join(electron, "checksums.json"), JSON.stringify({
    "electron-v44.10.1-darwin-arm64.zip": hash(readFileSync(zip)),
  }));
  writeFileSync(join(electron, "node_modules/@electron/get/index.js"),
    `exports.downloadArtifact = async () => ${JSON.stringify(zip)};\n`);
  execFileSync(process.execPath, [join(target, "install.mjs")], {
    env: { ...process.env, PWRAGENT_HOME: join(root, "home"), npm_config_platform: "darwin", npm_config_arch: "arm64" },
    stdio: "pipe",
  });
  return join(electron, "dist/Electron.app/Contents/MacOS/Electron");
}

it.skipIf(process.platform !== "darwin")("APFS oracle: repeated extraction shares blocks with independent writable files", () => {
  const setup = fixture();
  const probe = join(setup.root, "private-size");
  execFileSync("clang", [join(here, "fixtures/apfs-private-size.c"), "-o", probe]);
  const first = installAt(setup, "first");
  const second = installAt(setup, "second");
  const metadata = () => execFileSync(probe, [first, second], { encoding: "utf8" }).trim().split("\n").map(JSON.parse);
  expect(hash(readFileSync(first))).toBe(hash(readFileSync(second)));
  const [a, b] = metadata();
  expect(a.inode).not.toBe(b.inode);
  expect(a.cloneId).not.toBe("0");
  expect(a.cloneId).toBe(b.cloneId);
  expect(a.privateBytes + b.privateBytes).toBe(0);
  const original = hash(readFileSync(first));
  writeFileSync(second, randomBytes(1024 * 1024));
  expect(hash(readFileSync(first))).toBe(original);
  expect(metadata()[1].privateBytes).toBeGreaterThan(0);
}, 30_000);
