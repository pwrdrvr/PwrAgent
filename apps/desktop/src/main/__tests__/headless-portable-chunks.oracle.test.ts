import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, inject, it } from "vitest";
// Keep the build script in Vitest's watch graph. Global setup runs the build.
import "../../../scripts/build-headless.mjs";
import { requireOracleFixture, type PortableOutpostFixture } from "../../test-setup/oracle-fixture-context";

const execute = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "../../../../../packages/pwragent");
let fixture: PortableOutpostFixture;

beforeAll(() => {
  fixture = requireOracleFixture(inject("portableOutpost"));
});

it("resolves every declared runtime external to the installed dependency from the portable fixture", () => {
  const fixtureRequire = createRequire(path.join(fixture.directory, "index.js"));
  for (const [name, target] of Object.entries(fixture.externalTargets)) {
    expect(fs.realpathSync(fixtureRequire.resolve(`${name}/package.json`))).toBe(target);
  }
});

it("the portable emitted startup graph excludes optional code and loads each feature on first use", async () => {
  const { stdout } = await execute(process.execPath, [path.join(packageRoot, "scripts/portable-oracle.mjs"), fixture.directory], {
    env: { ...process.env, PWRAGENT_HOME: path.join(fixture.root, "home") },
  });
  const result = JSON.parse(stdout) as { startupChunks: number; optionalChunks: number };
  expect(result.startupChunks).toBeGreaterThan(1);
  expect(result.optionalChunks).toBeGreaterThan(6);
});

it("emits native ESM at every established entry path without wrappers or source maps", async () => {
  const { directory } = fixture;
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
