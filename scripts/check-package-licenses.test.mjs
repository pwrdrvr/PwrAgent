import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];

function writeFile(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "pwragent-first-party-licenses-"));
  temporaryDirectories.push(root);
  // The repository's workspace configuration owns membership. The fixture's
  // manifest map is the oracle, independent of the checker's discovery code.
  copyFileSync(join(repoRoot, "pnpm-workspace.yaml"), join(root, "pnpm-workspace.yaml"));
  const manifests = [
    "package.json",
    "apps/example-app/package.json",
    "packages/example-core/package.json",
    "packages/messaging/example-interface/package.json",
    "packages/messaging/providers/example-provider/package.json",
  ];
  for (const [index, path] of manifests.entries()) {
    writeFile(root, path, JSON.stringify({ name: `invented-first-party-${index}`, license: "MIT" }));
  }
  writeFile(root, ".gitignore", ".local/\nnode_modules/\ndist/\n");
  writeFile(root, ".local/archive-restore-probe/run-invented/codex-home/.tmp/plugins/example/package.json",
    JSON.stringify({ name: "invented-cache-package", license: "BSD-2-Clause" }));
  writeFile(root, "apps/example-app/.local/protocol-captures/example/package.json",
    JSON.stringify({ name: "invented-capture-package" }));
  writeFile(root, "packages/example-core/dist/example/package.json", "invalid invented JSON");
  writeFile(root, "packages/example-core/node_modules/example/package.json", "invalid invented JSON");
  writeFile(root, "scripts/fixtures/example/package.json",
    JSON.stringify({ name: "invented-nested-fixture", license: "BSD-2-Clause" }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(repoRoot, "scripts/check-package-licenses.mjs"), join(root, "scripts/check-package-licenses.mjs"));
  return { root, manifests };
}

function runCheck(root, guard = false, entryRoot = root) {
  const env = { ...process.env };
  if (guard) {
    const guardPath = join(root, "guard.cjs");
    writeFileSync(guardPath, `
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const forbidden = ${JSON.stringify([
  ".local",
  "apps/example-app/.local",
  "packages/example-core/dist",
  "packages/example-core/node_modules",
  "scripts/fixtures",
])}.map((entry) => path.join(__dirname, entry));
function check(target) {
  if (typeof target !== "string") return;
  const absolute = path.resolve(target);
  if (forbidden.some((entry) => absolute === entry || absolute.startsWith(entry + path.sep))) {
    fs.appendFileSync(path.join(__dirname, "forbidden-reads.log"), absolute + "\\n");
    throw new Error("read outside first-party workspace: " + absolute);
  }
}
for (const name of ["readFileSync", "readdirSync", "readFile", "readdir"]) {
  const original = fs[name];
  fs[name] = function (target, ...args) {
    check(target);
    return original.call(this, target, ...args);
  };
}
for (const name of ["readFile", "readdir"]) {
  const original = fs.promises[name];
  fs.promises[name] = function (target, ...args) {
    check(target);
    return original.call(this, target, ...args);
  };
}
syncBuiltinESMExports();
`);
    // Inherited by pnpm too: discovery must obey the same read boundary.
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(guardPath)}`;
  }
  const result = spawnSync(process.execPath, [
    ...(entryRoot === root ? [] : ["--preserve-symlinks-main"]),
    join(entryRoot, "scripts/check-package-licenses.mjs"),
  ], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  const forbiddenReads = join(root, "forbidden-reads.log");
  // Record attempts as well as throwing: pnpm must not swallow a read error
  // and turn an out-of-scope traversal into an apparently passing check.
  expect(existsSync(forbiddenReads) ? readFileSync(forbiddenReads, "utf8") : "").toBe("");
  return result;
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("first-party package license workspace oracle", () => {
  it("does not classify ignored cache manifests as first-party", () => {
    const { root } = createWorkspace();
    const result = runCheck(root);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("package license check passed");
  });

  it("does not read ignored caches, provider homes, build output, or nested fixtures", () => {
    const { root } = createWorkspace();
    const result = runCheck(root, true);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it("follows workspace configuration changes and always enforces the root license", () => {
    const { root } = createWorkspace();
    writeFile(root, "pnpm-workspace.yaml", `packages:
  - tools/*
recursiveIncludeWorkspaceRoot: false
`);
    writeFile(root, "package.json", JSON.stringify({ name: "invented-root" }));
    writeFile(root, "tools/example/package.json", JSON.stringify({ name: "invented-tool" }));
    // The previous workspace members are no longer first-party packages.
    writeFile(root, "apps/example-app/package.json", "invalid invented JSON");
    const result = runCheck(root, true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.split("\n").filter((line) => line.startsWith("- ")).sort()).toEqual([
      '- package.json declares license undefined; expected "MIT"',
      `- ${join("tools", "example", "package.json")} declares license undefined; expected "MIT"`,
    ]);
  });

  it("uses physical workspace identity when the entrypoint has a path alias", () => {
    const { root, manifests } = createWorkspace();
    const aliases = mkdtempSync(join(tmpdir(), "pwragent-license-alias-"));
    temporaryDirectories.push(aliases);
    const entryRoot = join(aliases, "workspace");
    symlinkSync(root, entryRoot, process.platform === "win32" ? "junction" : "dir");
    for (const path of manifests) {
      writeFile(root, path, JSON.stringify({ name: "invented-unlicensed-package" }));
    }
    const result = runCheck(root, true, entryRoot);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    // Filesystem identity is the oracle: an alias must not change diagnostics
    // or cause the explicitly included root to be checked a second time.
    const actual = result.stderr.split("\n").filter((line) => line.startsWith("- "));
    expect(actual.sort()).toEqual(manifests.map((path) =>
      `- ${join(...path.split("/"))} declares license undefined; expected "MIT"`,
    ).sort());
  });

  it.each([undefined, "BSD-2-Clause"])("rejects license %s on every first-party manifest", (license) => {
    const { root, manifests } = createWorkspace();
    for (const path of manifests) {
      const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
      writeFile(root, path, JSON.stringify({ ...manifest, license }));
    }
    const result = runCheck(root, true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    // Each workspace level and the root must be checked, with no extra files.
    const actual = result.stderr.split("\n").filter((line) => line.startsWith("- "));
    const expected = manifests.map((path) =>
      `- ${join(...path.split("/"))} declares license ${JSON.stringify(license)}; expected "MIT"`,
    );
    expect(actual.sort()).toEqual(expected.sort());
  });
});
