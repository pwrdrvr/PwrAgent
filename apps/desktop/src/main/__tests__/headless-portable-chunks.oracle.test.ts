import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildHeadless } from "../../../scripts/build-headless.mjs";

const execute = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "../../../../../packages/pwragent");
let root: string;
let directory: string;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pa-portable-chunks-")));
  directory = path.join(root, "dist");
  // Use the same native dependencies as a packed install. All other runtime
  // libraries must come from the portable output, not external checkout paths.
  fs.symlinkSync(path.join(packageRoot, "node_modules"), path.join(root, "node_modules"), "junction");
  await buildHeadless({ outputDirectory: directory, portable: true, sourcemap: false, logLevel: "warning" });
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it("the portable emitted startup graph excludes optional code and loads each feature on first use", async () => {
  const { stdout } = await execute(process.execPath, [path.join(packageRoot, "scripts/portable-oracle.mjs"), directory], {
    env: { ...process.env, PWRAGENT_HOME: path.join(root, "home") },
  });
  const result = JSON.parse(stdout) as { startupChunks: number; optionalChunks: number };
  expect(result.startupChunks).toBeGreaterThan(1);
  expect(result.optionalChunks).toBeGreaterThan(6);
});

it("keeps executable CJS entry paths, ESM direct execution, and source-map suppression", async () => {
  const files = fs.readdirSync(directory);
  expect(files.filter(file => file.endsWith(".map"))).toEqual([]);
  for (const entry of ["index.js", "index.mjs"]) {
    const { stdout } = await execute(process.execPath, [path.join(directory, entry), "--version"]);
    expect(stdout.trim()).toBe(JSON.parse(fs.readFileSync(path.join(directory, "runtime.json"), "utf8")).appVersion);
  }
});

it("shared Outpost test preparation emits the real package without source maps", () => {
  const files = fs.readdirSync(path.join(packageRoot, "dist"));
  expect(files).toContain("index.mjs");
  expect(files.filter(file => file.endsWith(".map"))).toEqual([]);
});
