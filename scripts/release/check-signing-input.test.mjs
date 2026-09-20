import { spawnSync } from "node:child_process";
import {
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const checker = fileURLToPath(new URL("./check-signing-input.mjs", import.meta.url));
const checkerModule = new URL("./check-signing-input.mjs", import.meta.url);
const materializerModule = new URL("./materialize-signing-input.mjs", import.meta.url);
const archiveVerifierModule = new URL("./verify-signing-input-archive.mjs", import.meta.url);

function check(code) {
  return spawnSync(process.execPath, [
    "--experimental-vm-modules", "--input-type=module", "-e",
    `import { checkPlatformRuntimeClosure, checkSigningInput, checkPlatformSigningInput, signingInputPaths } from ${JSON.stringify(checkerModule.href)};\n${code}`,
  ], { encoding: "utf8" });
}

function copyWindowsSigningInputSources(input, paths) {
  const root = resolve(dirname(checker), "../..");
  for (const path of paths.filter((path) => path !== "apps/desktop/release-stage")) {
    mkdirSync(dirname(join(input, path)), { recursive: true });
    cpSync(join(root, path), join(input, path));
  }
}

function writeStagedToolchain(input, { missingSimplify = false } = {}) {
  const stage = join(input, "apps/desktop/release-stage");
  const cache = join(input, "toolchain-cache/semver");
  const nestedSemver = join(stage, "node_modules/app-builder-lib/node_modules/semver");
  mkdirSync(join(stage, "node_modules/electron-builder"), { recursive: true });
  mkdirSync(join(stage, "node_modules/app-builder-lib"), { recursive: true });
  mkdirSync(join(stage, "node_modules/@electron/asar"), { recursive: true });
  mkdirSync(join(cache, "ranges"), { recursive: true });
  mkdirSync(nestedSemver, { recursive: true });
  mkdirSync(join(nestedSemver, "ranges"), { recursive: true });
  writeFileSync(join(stage, "package.json"), "{}\n");
  writeFileSync(
    join(stage, "node_modules/electron-builder/index.js"),
    'module.exports = require("app-builder-lib");\n',
  );
  writeFileSync(
    join(stage, "node_modules/app-builder-lib/index.js"),
    'module.exports = require("./node_modules/semver");\n',
  );
  writeFileSync(join(stage, "node_modules/@electron/asar/index.js"), "module.exports = {};\n");
  writeFileSync(
    join(cache, "index.js"),
    'module.exports = require("./ranges/simplify");\n',
  );
  linkSync(join(cache, "index.js"), join(nestedSemver, "index.js"));
  if (!missingSimplify) {
    writeFileSync(join(cache, "ranges/simplify.js"), "module.exports = [];\n");
    linkSync(
      join(cache, "ranges/simplify.js"),
      join(nestedSemver, "ranges/simplify.js"),
    );
  }
  return { cache, nestedSemver, stage };
}

function materializeWindowsSigningInput(input, output) {
  return spawnSync(process.execPath, [
    "--experimental-vm-modules", "--input-type=module", "-e",
    `import { materializeSigningInput } from ${JSON.stringify(materializerModule.href)};
import { signingInputPaths } from ${JSON.stringify(checkerModule.href)};
materializeSigningInput("windows", ${JSON.stringify(output)}, signingInputPaths.windows, ${JSON.stringify(input)});`,
  ], { encoding: "utf8" });
}

function verifyWindowsSigningInputArchive(archive) {
  return spawnSync(process.execPath, [
    "--experimental-vm-modules", "--input-type=module", "-e",
    `import { verifySigningInputArchive } from ${JSON.stringify(archiveVerifierModule.href)};
import { signingInputPaths } from ${JSON.stringify(checkerModule.href)};
verifySigningInputArchive("windows", ${JSON.stringify(archive)}, signingInputPaths.windows);`,
  ], { encoding: "utf8" });
}

for (const platform of ["windows", "macos"]) {
  it(`${platform} archive includes the ASAR helper and all static local imports`, () => {
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", checker, platform], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split(/\r?\n/)).toContain("apps/desktop/scripts/packaged-html-rules.mjs");
  });

  it(`${platform} rejects the beta.2 missing-helper regression`, () => {
    const result = check(`checkPlatformSigningInput("${platform}", signingInputPaths.${platform}.filter(path => !path.endsWith("/packaged-html-rules.mjs")));`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verify-asar-contents.mjs imports ./packaged-html-rules.mjs");
  });
}

// These replaced the old release.yml tar-list assertions. Neither is a
// static import, so dropping either must still fail the platform contract.
for (const path of [
  "apps/desktop/release-stage-arm64",
  "apps/desktop/scripts/assemble-mac-release.mjs",
]) {
  it(`rejects the macOS archive without ${path}`, () => {
    const result = check(`checkPlatformSigningInput("macos", signingInputPaths.macos.filter(path => path !== ${JSON.stringify(path)}));`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Signing input omits required entry point ${path}`);
  });
}

it("checks transitive re-exports without executing staged scripts or reading import-like comments", () => {
  const sources = {
    "entry.mjs": 'import { x } from "./lib/helper.mjs"; process.exit(99); // import "./comment.mjs"',
    "lib/helper.mjs": 'export { x } from "../missing.mjs";',
  };
  const result = check(`const sources = ${JSON.stringify(sources)}; checkSigningInput(Object.keys(sources), path => sources[path]);`);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("lib/helper.mjs imports ../missing.mjs");
  expect(result.stderr).not.toContain("omits comment.mjs");
});

it("materializes hard-linked Windows toolchain files before validating the extracted archive", () => {
  const root = resolve(dirname(checker), "../..");
  const paths = JSON.parse(readFileSync(join(root, "scripts/release/signing-input-paths.json"), "utf8")).windows;
  const temp = mkdtempSync(join(tmpdir(), "signing-input-contract-"));
  try {
    const input = join(temp, "input");
    const materialized = join(temp, "materialized");
    copyWindowsSigningInputSources(input, paths);
    const { cache, nestedSemver } = writeStagedToolchain(input);
    expect(statSync(join(cache, "index.js")).ino).toBe(statSync(join(nestedSemver, "index.js")).ino);

    const copied = materializeWindowsSigningInput(input, materialized);
    expect(copied.status, copied.stderr).toBe(0);
    expect(statSync(join(materialized, "apps/desktop/release-stage/node_modules/app-builder-lib/node_modules/semver/index.js")).ino)
      .not.toBe(statSync(join(cache, "index.js")).ino);

    const archive = join(temp, "input.tgz");
    // Git for Windows' tar treats an absolute C:\\ path as a remote-host
    // archive name, so keep the test fixture's archive path relative.
    const packed = spawnSync("tar", ["-czf", "../input.tgz", ...paths], {
      cwd: materialized,
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const verified = verifyWindowsSigningInputArchive(archive);
    expect(verified.status, verified.stderr).toBe(0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("rejects a staged Windows toolchain with a missing transitive dependency", () => {
  const temp = mkdtempSync(join(tmpdir(), "signing-input-runtime-"));
  try {
    writeStagedToolchain(temp, { missingSimplify: true });
    const result = check(`checkPlatformRuntimeClosure("windows", ${JSON.stringify(temp)});`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot load electron-builder from the staged toolchain");
    expect(result.stderr).toContain("./ranges/simplify");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
