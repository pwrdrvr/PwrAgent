import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  const require = createRequire(import.meta.url);
  const ptyRequire = createRequire(require.resolve("node-pty/package.json"));
  const nativePackages = [["node-pty", require], ["node-addon-api", ptyRequire]];
  run(process.execPath, [path.join(root, "scripts/build.mjs")], { cwd: root });
  // npm pack follows pnpm's external symlinks and can emit ../../.pnpm paths.
  // Stage a flat dependency tree without mutating the checkout's node_modules.
  const staging = path.join(temporary, "package");
  mkdirSync(staging);
  for (const file of ["package.json", "bin", "src", "examples", "README.md", "LICENSE", "dist", "licenses"]) {
    cpSync(path.join(root, file), path.join(staging, file), { recursive: true, dereference: true });
  }
  if (source) writeFileSync(path.join(staging, "package.json"), JSON.stringify({ ...pkg, pwragentRelease: source }, null, 2) + "\n");
  for (const [name, resolver] of nativePackages) {
    cpSync(path.dirname(resolver.resolve(`${name}/package.json`)), path.join(staging, "node_modules", name), { recursive: true, dereference: true });
  }
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { cwd: staging }));
  const tarball = path.join(temporary, packed.filename);
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of ["package.json", "bin/pwragent.js", "src/cli.js", "src/daemon.js",
    "dist/federation-core.js", "dist/ws-LICENSE", "dist/THIRD_PARTY_LICENSES", "licenses/xterm-LICENSE",
    "LICENSE", "README.md", "examples/pwragent-headless.service"]) {
    assert.ok(files.has(required), `Missing packed file: ${required}`);
  }
  for (const file of files) {
    assert.ok(!file.split("/").includes(".."), `Packed paths must stay inside the package: ${file}`);
    assert.match(file, /^(package\.json|LICENSE|README\.md|bin\/[^/]+\.js|src\/[^/]+\.(js|ts)|examples\/[^/]+\.service|dist\/(federation-core\.js|ws-LICENSE|THIRD_PARTY_LICENSES)|licenses\/xterm-LICENSE|node_modules\/(node-pty|node-addon-api)\/(?!.*(?:^|\/)node_modules\/).+)$/,
      `Unexpected packed file: ${file}`);
  }
  const unpacked = (file) => run("tar", ["-xOf", tarball, `package/${file}`]);
  const packedPackage = JSON.parse(unpacked("package.json"));
  assert.deepEqual(releaseMetadata(packedPackage), releaseMetadata(pkg));
  assert.deepEqual(packedPackage.pwragentRelease, source);
  assert.equal(unpacked("LICENSE"), readFileSync(path.join(root, "LICENSE"), "utf8"));
  const federationRequire = createRequire(require.resolve("@pwragent/federation/federation-transport"));
  const wsPackage = federationRequire.resolve("ws/package.json");
  assert.equal(JSON.parse(readFileSync(wsPackage, "utf8")).license, "MIT");
  assert.equal(unpacked("dist/ws-LICENSE"), readFileSync(path.join(path.dirname(wsPackage), "LICENSE"), "utf8"));
  assert.deepEqual([...packed.bundled].sort(), ["node-addon-api", "node-pty"]);
  for (const [name, resolver] of nativePackages) {
    const sourcePackagePath = resolver.resolve(`${name}/package.json`);
    const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, "utf8"));
    const bundledPackage = JSON.parse(unpacked(`node_modules/${name}/package.json`));
    assert.equal(bundledPackage.name, name);
    assert.equal(bundledPackage.version, sourcePackage.version);
    assert.equal(bundledPackage.license, "MIT");
    assert.deepEqual(bundledPackage.dependencies, sourcePackage.dependencies);
    const licenseFiles = readdirSync(path.dirname(sourcePackagePath)).filter((file) => /^licen[cs]e(?:[.-]|$)/i.test(file));
    assert.ok(licenseFiles.length > 0, `Missing native dependency license: ${name}`);
    for (const file of licenseFiles) {
      assert.equal(unpacked(`node_modules/${name}/${file}`), readFileSync(path.join(path.dirname(sourcePackagePath), file), "utf8"));
    }
  }
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
  // No workspace links, registry downloads, install scripts or ambient npm cache.
  run("npm", ["install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
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
