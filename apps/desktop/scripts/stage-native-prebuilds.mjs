/**
 * Stage each native dependency's prebuilt binary for the architecture being
 * packed at the package's conventional build/Release path, before
 * electron-builder collects the production files.
 *
 * better-sqlite3 13 and node-pty 1.2 both ship every supported platform/arch
 * as a Node-API prebuild inside the package, and both load build/Release when
 * it exists. Node-API binaries carry no Node or Electron ABI, so nothing here
 * compiles: one copy serves the packaged Electron runtime.
 *
 * Packaging the multi-arch prebuild directories unchanged breaks
 * @electron/universal, because the temporary x64 and arm64 apps would both
 * contain the same foreign-arch files. For each real architecture pass, copy
 * only that target's files to build/Release. electron-builder.yml excludes the
 * original prebuild directories and disables electron-builder's own rebuild,
 * which would otherwise compile from source. @electron/universal then
 * lipo-merges the two Darwin slices at the common path.
 *
 * Mirrors pwrdrvr/PwrGit's stage-better-sqlite3-arch.mjs (#159, #168), plus
 * node-pty, which PwrGit does not ship.
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

// Files node-pty loads or spawns on every terminal, per platform. Windows also
// ships conpty/conpty.dll, which node-pty loads only with useConptyDll.
export const NODE_PTY_REQUIRED_FILES = {
  darwin: ["pty.node", "spawn-helper"],
  linux: ["pty.node"],
  win32: ["conpty.node", "conpty_console_list.node"],
};

export function stageNativePrebuilds({ appDir, platform, arch }) {
  return {
    betterSqlite3: stageBetterSqlite3({ appDir, platform, arch }),
    nodePty: stageNodePty({ appDir, platform, arch }),
  };
}

export function stageBetterSqlite3({ appDir, platform, arch }) {
  const sqliteDir = join(appDir, "node_modules", "better-sqlite3");
  const { packageJson, prebuild } = resolveBetterSqlite3Prebuild({
    sqliteDir,
    platform,
    arch,
  });

  const releaseDir = resetReleaseDir(sqliteDir);
  const target = join(releaseDir, "better_sqlite3.node");
  copyFileSync(prebuild, target);

  console.log(
    `  beforePack: staged better-sqlite3 ${packageJson.version} prebuild for ${platform}-${arch}`,
  );
  return target;
}

export function resolveBetterSqlite3Prebuild({ sqliteDir, platform, arch }) {
  const packageJson = readPackageJson(sqliteDir, "better-sqlite3");
  if (packageJson.gypfile !== false) {
    throw new Error(
      `better-sqlite3 ${packageJson.version} does not expose the v13 Node-API prebuild layout`,
    );
  }
  assertSupportedTarget("better-sqlite3", platform, arch);

  // Electron targets glibc on Linux, so the packaged slice is never linuxmusl.
  const prebuild = join(sqliteDir, "prebuilds", `${platform}-${arch}.node`);
  if (!existsSync(prebuild)) {
    throw new Error(
      `better-sqlite3 has no packaged Node-API binary for ${platform}-${arch}`,
    );
  }
  return { packageJson, prebuild };
}

export function stageNodePty({ appDir, platform, arch }) {
  const ptyDir = join(appDir, "node_modules", "node-pty");
  const { packageJson, prebuildDir } = resolveNodePtyPrebuild({
    ptyDir,
    platform,
    arch,
  });

  const releaseDir = resetReleaseDir(ptyDir);
  // Debug symbols are not loaded at runtime; everything else (conpty.dll and
  // OpenConsole.exe beside conpty.node on Windows) is.
  cpSync(prebuildDir, releaseDir, {
    recursive: true,
    filter: (source) => !source.endsWith(".pdb"),
  });
  if (platform !== "win32") {
    // node-pty spawns this helper directly; a lost mode bit fails every
    // terminal at spawn time rather than at load time.
    const helper = join(releaseDir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
  for (const file of NODE_PTY_REQUIRED_FILES[platform]) {
    if (!existsSync(join(releaseDir, file))) {
      throw new Error(`node-pty staging for ${platform}-${arch} is missing ${file}`);
    }
  }

  console.log(
    `  beforePack: staged node-pty ${packageJson.version} prebuild for ${platform}-${arch}`,
  );
  return releaseDir;
}

export function resolveNodePtyPrebuild({ ptyDir, platform, arch }) {
  const packageJson = readPackageJson(ptyDir, "node-pty");
  assertSupportedTarget("node-pty", platform, arch);

  const prebuildDir = join(ptyDir, "prebuilds", `${platform}-${arch}`);
  if (!existsSync(prebuildDir)) {
    throw new Error(`node-pty has no packaged prebuild for ${platform}-${arch}`);
  }
  return { packageJson, prebuildDir };
}

function readPackageJson(packageDir, name) {
  const packagePath = join(packageDir, "package.json");
  if (!existsSync(packagePath)) {
    throw new Error(`${name} package is missing at ${packageDir}`);
  }
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function assertSupportedTarget(name, platform, arch) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported ${name} package platform: ${platform}`);
  }
  if (!SUPPORTED_ARCHES.has(arch)) {
    throw new Error(`Unsupported ${name} package architecture: ${arch}`);
  }
}

// The previous architecture's pass, or a host build, must not leak into this
// one: the whole build directory belongs to the slice being packed.
function resetReleaseDir(packageDir) {
  const buildDir = join(packageDir, "build");
  const releaseDir = join(buildDir, "Release");
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });
  return releaseDir;
}
