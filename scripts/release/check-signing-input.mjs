import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const signingInputPaths = JSON.parse(readFileSync(
  resolve(repoRoot, "scripts/release/signing-input-paths.json"), "utf8",
));

// These are invoked by the jobs or by release.mjs as subprocesses, so they
// are roots even when no other module imports them.
const requiredPaths = {
  macos: [
    "apps/desktop/release-stage", "apps/desktop/release-stage-arm64",
    ".github/actions/select-xcode-for-actool",
    "apps/desktop/scripts/release.mjs", "apps/desktop/scripts/assemble-mac-release.mjs",
    "apps/desktop/scripts/verify-asar-contents.mjs",
    "apps/desktop/scripts/windows-release-artifacts.mjs",
    "apps/desktop/node_modules", "node_modules",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  ],
  windows: [
    "apps/desktop/release-stage", "apps/desktop/scripts/release.mjs",
    "apps/desktop/scripts/verify-asar-contents.mjs",
    "apps/desktop/scripts/windows-release-artifacts.mjs",
    "scripts/release/install-trusted-signing.ps1",
  ],
};

// Parse without executing release entry points (which package apps or exit).
// Node's module parser handles multiline imports and re-exports, including
// transitive imports: every explicitly staged module is inspected.
export function checkSigningInput(paths, readSource = (path) => readFileSync(resolve(repoRoot, path), "utf8")) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("Signing input needs a nonempty path allowlist");
  }
  const included = new Set(paths);
  for (const path of paths) {
    if (!path.endsWith(".mjs")) continue;
    const module = new vm.SourceTextModule(readSource(path), { identifier: path });
    for (const specifier of module.dependencySpecifiers) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const dependency = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (!included.has(dependency)) {
        throw new Error(`${path} imports ${specifier}, but signing input omits ${dependency}`);
      }
    }
  }
}

// Archive producers and release:check use this complete platform contract,
// including roots that an import-closure check cannot discover.
export function checkPlatformSigningInput(platform, paths = signingInputPaths[platform]) {
  checkSigningInput(paths);
  for (const path of requiredPaths[platform]) {
    if (!paths.includes(path)) throw new Error(`Signing input omits required entry point ${path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const paths = signingInputPaths[process.argv[2]];
    checkPlatformSigningInput(process.argv[2], paths);
    process.stdout.write(`${paths.join("\n")}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
