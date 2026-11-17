import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildHeadless } from "../../../scripts/build-headless.mjs";

const execute = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "../../../../../packages/pwragent");
const packageRequire = createRequire(path.join(packageRoot, "package.json"));
const externalDependencies = Object.keys(JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).dependencies);
let root: string;
let directory: string;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pa-portable-chunks-")));
  directory = path.join(root, "dist");
  // Link only the declared runtime externals to their installed real paths.
  // A junction to the whole pnpm node_modules tree does not preserve package
  // resolution from this temporary directory on Windows. Other libraries must
  // come from the portable output, as they do in a packed install.
  for (const name of externalDependencies) {
    const target = fs.realpathSync(path.dirname(packageRequire.resolve(`${name}/package.json`)));
    const link = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, "junction");
  }
  await buildHeadless({ outputDirectory: directory, portable: true, sourcemap: false, logLevel: "warning" });
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it("resolves every declared runtime external to the installed dependency from the portable fixture", () => {
  const fixtureRequire = createRequire(path.join(directory, "index.js"));
  for (const name of externalDependencies) {
    expect(fs.realpathSync(fixtureRequire.resolve(`${name}/package.json`))).toBe(
      fs.realpathSync(packageRequire.resolve(`${name}/package.json`)),
    );
  }
});

it("the portable emitted startup graph excludes optional code and loads each feature on first use", async () => {
  const { stdout } = await execute(process.execPath, [path.join(packageRoot, "scripts/portable-oracle.mjs"), directory], {
    env: { ...process.env, PWRAGENT_HOME: path.join(root, "home") },
  });
  const result = JSON.parse(stdout) as { startupChunks: number; optionalChunks: number };
  expect(result.startupChunks).toBeGreaterThan(1);
  expect(result.optionalChunks).toBeGreaterThan(6);
});

it("emits native ESM at every established entry path without wrappers or source maps", async () => {
  const files = fs.readdirSync(directory);
  expect(files.filter(file => file.endsWith(".map"))).toEqual([]);
  expect(JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).type).toBe("module");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "chunks.json"), "utf8")) as {
    entries: Record<string, string>; chunks: Record<string, unknown>;
  };
  for (const [name, file] of Object.entries(manifest.entries)) expect(file).toBe(`${name}.js`);
  expect(files.filter(file => /\.[cm]?js$/.test(file)).sort()).toEqual(Object.keys(manifest.chunks).sort());
  const { stdout } = await execute(process.execPath, [path.join(directory, manifest.entries.index), "--version"]);
  expect(stdout.trim()).toBe(JSON.parse(fs.readFileSync(path.join(directory, "runtime.json"), "utf8")).appVersion);
});

it("shared Outpost test preparation emits the real package without source maps", () => {
  const files = fs.readdirSync(path.join(packageRoot, "dist"));
  expect(files).toContain("index.js");
  expect(JSON.parse(fs.readFileSync(path.join(packageRoot, "dist/package.json"), "utf8")).type).toBe("module");
  expect(files.filter(file => file.endsWith(".map"))).toEqual([]);
});
