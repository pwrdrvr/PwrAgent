// Headless, opt-in APFS oracle using an existing ZIP and disposable installs.
// Never launches Electron or edits an installed runtime / preexisting cache.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRuntime, extractZip, inventory, sha256File } from "./electron-runtime-cache.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [zipArg, outputArg] = process.argv.slice(2);
if (process.platform !== "darwin" || !zipArg || !outputArg) {
  throw new Error("Usage (macOS/APFS): node probe-electron-runtime-sharing.mjs <existing-electron-zip> <report.json>");
}
const zip = resolve(zipArg);
const output = resolve(outputArg);
const require = createRequire(import.meta.url);
const electronRequire = createRequire(require.resolve("electron/package.json"));
const { version } = electronRequire("./package.json");
const platform = process.platform;
const arch = process.arch;
const checksum = electronRequire("./checksums.json")[`electron-v${version}-${platform}-${arch}.zip`];
assert.equal(await sha256File(zip), checksum, "ZIP must match the installed package's release checksum");
mkdirSync(dirname(output), { recursive: true });
const root = mkdtempSync(join(dirname(output), ".electron-sharing-probe-"));
try {
  const probe = join(root, "private-size");
  execFileSync("clang", [join(here, "fixtures/apfs-private-size.c"), "-o", probe]);
  const readMetadata = (files) => execFileSync(probe, files, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
    .trim().split("\n").map(JSON.parse);
  const legacy = [];
  for (const name of ["legacy-a", "legacy-b"]) {
    const dist = join(root, name);
    mkdirSync(dist);
    extractZip(zip, dist);
    legacy.push(dist);
  }
  const installs = ["clone-a", "clone-b"].map((name) => join(root, name));
  for (const electronDir of installs) mkdirSync(electronDir);
  await Promise.all(installs.map((electronDir) => ensureRuntime({
    electronDir, version, platform, arch, cacheRoot: join(root, "cache"),
    download: async () => zip, expectedChecksum: checksum, log: () => {},
  })));
  const files = (await inventory(legacy[0])).filter((entry) => entry.sha256).map((entry) => entry.path);
  const framework = "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework";
  const totals = (dist) => {
    const entries = readMetadata(files.map((file) => join(dist, file)));
    return {
      regularFiles: entries.length,
      allocatedBytes: entries.reduce((sum, entry) => sum + entry.allocatedBytes, 0),
      privateBytes: entries.reduce((sum, entry) => sum + entry.privateBytes, 0),
    };
  };
  const clonedDists = installs.map((install) => join(install, "dist"));
  const frameworkPaths = [...legacy, ...clonedDists].map((dist) => join(dist, framework));
  const frameworkMetadata = readMetadata(frameworkPaths);
  const frameworkHashes = await Promise.all(frameworkPaths.map(sha256File));
  assert.equal(new Set(frameworkHashes).size, 1);
  assert.equal(new Set(frameworkMetadata.map((entry) => entry.inode)).size, 4);
  assert.notEqual(frameworkMetadata[0].cloneId, frameworkMetadata[1].cloneId);
  assert.equal(frameworkMetadata[2].cloneId, frameworkMetadata[3].cloneId);
  assert.equal(frameworkMetadata[2].privateBytes + frameworkMetadata[3].privateBytes, 0);
  const legacyTotals = legacy.map(totals);
  const cloneTotals = clonedDists.map(totals);
  assert(legacyTotals.every((entry) => entry.privateBytes > 300_000_000));
  assert(cloneTotals.every((entry) => entry.privateBytes === 0));

  // Show why using Node's flag alone would silently reintroduce the bug.
  const nodeCopy = join(root, "node-copy");
  copyFileSync(frameworkPaths[2], nodeCopy, constants.COPYFILE_FICLONE);
  const nodeCopyMetadata = readMetadata([nodeCopy])[0];
  const fd = openSync(frameworkPaths[3], "r+");
  try { writeFileSync(fd, Buffer.alloc(4096, 0xa5)); } finally { closeSync(fd); }
  assert.equal(await sha256File(frameworkPaths[2]), frameworkHashes[2]);
  assert.notEqual(await sha256File(frameworkPaths[3]), frameworkHashes[3]);
  const report = {
    measuredAt: new Date().toISOString(), node: process.version, version, platform, arch, zipSha256: checksum,
    legacy: legacyTotals, cloned: cloneTotals, frameworkSha256: frameworkHashes[0], frameworkMetadata,
    nodeCopyMetadata, afterPrivateWrite: readMetadata(frameworkPaths.slice(2)),
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  rmSync(root, { recursive: true, force: true });
}
