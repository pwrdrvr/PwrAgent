import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const checker = fileURLToPath(new URL("./check-signing-input.mjs", import.meta.url));
function check(code) {
  return spawnSync(process.execPath, [
    "--experimental-vm-modules", "--input-type=module", "-e",
    `import { checkSigningInput, checkPlatformSigningInput, signingInputPaths } from ${JSON.stringify(new URL("./check-signing-input.mjs", import.meta.url).href)};\n${code}`,
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

it("archives and expands the Windows manifest with the verifier helper present", () => {
  const root = resolve(dirname(checker), "../..");
  const paths = JSON.parse(readFileSync(join(root, "scripts/release/signing-input-paths.json"), "utf8")).windows;
  const temp = mkdtempSync(join(tmpdir(), "signing-input-contract-"));
  try {
    const input = join(temp, "input");
    const output = join(temp, "output");
    mkdirSync(output);
    // Only the generated application stage is a fixture. All staged scripts
    // and the allowlist are the source-owned files the Windows producer uses.
    mkdirSync(join(input, "apps/desktop/release-stage"), { recursive: true });
    for (const path of paths.filter(path => path !== "apps/desktop/release-stage")) {
      mkdirSync(dirname(join(input, path)), { recursive: true });
      cpSync(join(root, path), join(input, path));
    }
    // Both working directories are siblings beneath temp. A relative archive
    // path also works with Git Bash's GNU tar, which parses the colon in an
    // absolute Windows drive path as a remote-host separator.
    const archive = "../input.tgz";
    const packed = spawnSync("tar", ["-czf", archive, ...paths], { cwd: input, encoding: "utf8" });
    expect(packed.status, packed.stderr).toBe(0);
    const expanded = spawnSync("tar", ["-xzf", archive], { cwd: output, encoding: "utf8" });
    expect(expanded.status, expanded.stderr).toBe(0);
    const result = check(`
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      checkSigningInput(signingInputPaths.windows, path => readFileSync(join(${JSON.stringify(output)}, path), "utf8"));
    `);
    expect(result.status, result.stderr).toBe(0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
