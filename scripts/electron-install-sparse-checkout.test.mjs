import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = "apps/desktop/scripts/ensure-electron-runtime.mjs";
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sparseInstalls(workflow) {
  const lines = readFileSync(join(root, workflow), "utf8").split("\n");
  const checkouts = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== "sparse-checkout: |") continue;
    const indentation = lines[index].search(/\S/);
    const patterns = [];
    for (let next = index + 1; next < lines.length && lines[next].search(/\S/) > indentation; next++) {
      patterns.push(lines[next].trim());
    }
    if (patterns.includes(entry)) checkouts.push({ workflow, line: index + 1, patterns });
  }
  return checkouts;
}

// Discover the actual local import closure, rather than maintaining a second
// list of helper names that could omit the same dependency as the workflow.
function importClosure(file, files = new Map()) {
  if (files.has(file)) return files;
  const source = readFileSync(join(root, file), "utf8");
  files.set(file, source);
  for (const [, specifier] of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
    importClosure(join(dirname(file), specifier), files);
  }
  return files;
}

const checkouts = [".github/workflows/ci.yml", ".github/workflows/release.yml"].flatMap(sparseInstalls);

it("covers all dependency-install sparse checkouts", () => {
  expect(checkouts.filter(({ workflow }) => workflow.endsWith("/ci.yml"))).toHaveLength(3);
  expect(checkouts.filter(({ workflow }) => workflow.endsWith("/release.yml"))).toHaveLength(1);
});

it.each(checkouts)("Git oracle: $workflow:$line retains the Electron install import closure", ({ workflow, line, patterns }) => {
  const directory = mkdtempSync(join(tmpdir(), "pwragent-sparse-install-"));
  directories.push(directory);
  const git = (args, options = {}) => execFileSync("git", args, {
    cwd: directory, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options,
  });
  git(["init", "--quiet"]);
  const files = importClosure(entry);
  for (const [file, source] of files) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), source);
  }
  git(["add", "--force", "."]);
  const tree = git(["write-tree"]).trim();
  mkdirSync(join(directory, ".git/info"), { recursive: true });
  writeFileSync(join(directory, ".git/info/sparse-checkout"), `${patterns.join("\n")}\n`);
  // Git itself decides what these non-cone patterns retain. No fixture commit
  // or network is needed: apply the written tree directly to the index.
  git(["-c", "core.sparseCheckout=true", "-c", "core.sparseCheckoutCone=false", "read-tree", "-mu", tree]);
  for (const file of files.keys()) {
    expect(existsSync(join(directory, file)), `${workflow}:${line} omits required import ${file}`).toBe(true);
  }
});
