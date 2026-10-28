import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseMetadata } from "./release.mjs";

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
  releaseMetadata(pkg);
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--foreground-scripts=false", "--pack-destination", temporary], { cwd: root }));
  const tarball = path.join(temporary, packed.filename);
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of ["package.json", "bin/pwragent.js", "src/cli.js", "src/daemon.js",
    "dist/federation-core.js", "dist/ws-LICENSE", "dist/THIRD_PARTY_LICENSES", "licenses/xterm-LICENSE",
    "LICENSE", "README.md", "examples/pwragent-headless.service"]) {
    assert.ok(files.has(required), `Missing packed file: ${required}`);
  }
  for (const file of files) {
    assert.match(file, /^(package\.json|LICENSE|README\.md|bin\/[^/]+\.js|src\/[^/]+\.(js|ts)|examples\/[^/]+\.service|licenses\/xterm-LICENSE|dist\/(federation-core\.js|ws-LICENSE|THIRD_PARTY_LICENSES))$/,
      `Unexpected packed file: ${file}`);
  }
  const unpacked = (file) => run("tar", ["-xOf", tarball, `package/${file}`]);
  const packedPackage = JSON.parse(unpacked("package.json"));
  assert.deepEqual(releaseMetadata(packedPackage), releaseMetadata(pkg));
  assert.equal(unpacked("LICENSE"), readFileSync(path.join(root, "LICENSE"), "utf8"));
  const require = createRequire(import.meta.url);
  const federationRequire = createRequire(require.resolve("@pwragent/federation/federation-transport"));
  const wsPackage = federationRequire.resolve("ws/package.json");
  assert.equal(JSON.parse(readFileSync(wsPackage, "utf8")).license, "MIT");
  assert.equal(unpacked("dist/ws-LICENSE"), readFileSync(path.join(path.dirname(wsPackage), "LICENSE"), "utf8"));
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
  // Seed a new cache with only the declared native dependency and its npm
  // dependencies. The installed CLI below must then work offline, without
  // workspace links, lifecycle scripts or the operator's npm cache.
  const dependencies = path.join(temporary, "runtime-dependencies");
  mkdirSync(dependencies);
  writeFileSync(path.join(dependencies, "package.json"), JSON.stringify({
    private: true, license: "MIT", dependencies: packedPackage.dependencies,
  }));
  run("npm", ["install", "--prefix", dependencies, "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"],
    { cwd: temporary, env });
  run("npm", ["install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: temporary, env });
  const fixture = path.join(temporary, "codex.mjs");
  copyFileSync(path.join(root, "test/fixtures/codex.js"), fixture);
  chmodSync(fixture, 0o755);
  run(process.execPath, [path.join(root, "scripts/smoke-installed.mjs"), path.join(prefix, "bin/pwragent"), fixture, temporary],
    { cwd: temporary, env, stdio: "inherit" });
  copyFileSync(tarball, path.join(output, packed.filename));
  writeFileSync(path.join(output, "pack.json"), JSON.stringify(packed, null, 2) + "\n");
  console.log(`Validated ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes, ${packed.integrity}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
