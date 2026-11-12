import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPublicRegistry, releaseMetadata } from "./release.mjs";
import { currentReleaseSource } from "./release-context.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// macOS TMPDIR can leave too few bytes for the daemon's Unix socket path.
const temporary = mkdtempSync(path.join(realpathSync("/tmp"), "pa-pack-"));
const output = path.resolve(process.argv[2] || path.join(root, "../../.local/headless-package"));
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options,
});

try {
  mkdirSync(output, { recursive: true });
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const desktop = JSON.parse(readFileSync(new URL("../../../apps/desktop/package.json", import.meta.url), "utf8"));
  const metadata = releaseMetadata(pkg, { desktopVersion: desktop.version });
  const context = process.env.RELEASE_TAG ? currentReleaseSource() : undefined;
  const source = context ? { tag: context.tag, commit: context.commit } : undefined;
  run(process.execPath, [path.join(root, "scripts/build.mjs")], { cwd: root });
  const staging = path.join(temporary, "package");
  mkdirSync(staging);
  for (const file of ["package.json", "bin", "src", "examples", "README.md", "LICENSE", "dist", "licenses", "resources", "scripts", "native"]) {
    cpSync(path.join(root, file), path.join(staging, file), { recursive: true, dereference: true });
  }
  if (source) writeFileSync(path.join(staging, "package.json"), JSON.stringify({ ...pkg, pwragentRelease: source }, null, 2) + "\n");
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { cwd: staging }));
  const tarball = path.join(temporary, packed.filename);
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of ["package.json", "bin/pwragent.js", "src/cli.js", "src/daemon.js", "dist/index.js", "dist/runtime.json",
    "dist/storage-maintenance-worker.js", "dist/claude-session-reader-worker.js", "dist/mcp-connection-bridge.js", "dist/token-miser-hook.js", "dist/outpost-codex-sandbox.js",
    "dist/THIRD_PARTY_LICENSES", "resources/custom-git-runtime.json", "native/mcp-ipc-relay/main.c", "scripts/install.mjs", "scripts/stage-runtime.mjs", "LICENSE", "README.md"]) {
    assert.ok(files.has(required), `Missing packed file: ${required}`);
  }
  for (const file of files) assert.ok(!file.split("/").includes(".."), `Packed path escapes package: ${file}`);
  for (const file of ["runtime.js", "federation-backend.js", "federation.js", "federation-core.ts", "codex.js", "store.js", "projects.js", "handoffs.js", "owner-thread-registry.js"]) {
    assert.ok(!files.has(`src/${file}`), `Retired runtime shipped: ${file}`);
  }
  const extracted = path.join(temporary, "extracted");
  mkdirSync(extracted);
  run("tar", ["-xf", tarball, "-C", extracted]);
  const unpacked = file => readFileSync(path.join(extracted, "package", file), "utf8");
  const packedPackage = JSON.parse(unpacked("package.json"));
  assert.deepEqual(releaseMetadata(packedPackage), releaseMetadata(pkg));
  assert.deepEqual(packedPackage.pwragentRelease, source);
  assert.equal(unpacked("LICENSE"), readFileSync(path.join(root, "LICENSE"), "utf8"));
  assert.ok(!/require\(["'](?:\/|[A-Za-z]:)/.test(unpacked("dist/index.js")), "Portable bundle must not require build-host absolute paths");
  assert.deepEqual(packed.bundled, []);
  assert.ok(![...files].some(file => file.startsWith("resources/git/") || file === "resources/mcp-ipc-relay/mcp-ipc-relay"), "Do not pack build-host binaries");
  assert.equal(unpacked("scripts/stage-runtime.mjs"), readFileSync(new URL("../../../apps/desktop/scripts/stage-runtime.mjs", import.meta.url), "utf8"));
  assert.equal(unpacked("dist/THIRD_PARTY_LICENSES"), readFileSync(path.join(root, "dist/THIRD_PARTY_LICENSES"), "utf8"));
  assert.equal(unpacked("licenses/xterm-LICENSE"), readFileSync(path.join(root, "licenses/xterm-LICENSE"), "utf8"));
  assert.match(unpacked("bin/pwragent.js"), /^#!\/usr\/bin\/env node\n/);
  assert.ok(packed.files.find((file) => file.path === "bin/pwragent.js").mode & 0o111, "CLI must be executable");
  const home = path.join(temporary, "home");
  mkdirSync(home);
  const npmrc = path.join(home, ".npmrc");
  writeFileSync(npmrc, "");
  const prefix = path.join(temporary, "install");
  const env = { ...process.env, HOME: home, NODE_PATH: "", NODE_OPTIONS: "",
    NPM_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_CACHE: path.join(temporary, "cache") };
  // Install the tarball away from the checkout. npm selects target-native packages.
  run("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarball],
    { cwd: temporary, env });
  const fixture = path.join(temporary, "codex.mjs");
  copyFileSync(path.join(root, "test/fixtures/codex.js"), fixture);
  chmodSync(fixture, 0o755);
  run(process.execPath, [path.join(root, "scripts/smoke-installed.mjs"), path.join(prefix, "bin/pwragent"), fixture, temporary],
    { cwd: temporary, env, stdio: "inherit" });
  copyFileSync(tarball, path.join(output, packed.filename));
  if (source) {
    packed.release = source;
    await checkPublicRegistry(metadata, { integrity: packed.integrity, source, branch: context.branch });
  }
  writeFileSync(path.join(output, "pack.json"), JSON.stringify(packed, null, 2) + "\n");
  console.log(`Validated ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes, ${packed.integrity}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
