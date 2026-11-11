import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildHeadless } from "../../../scripts/build-headless.mjs";
import { LOADED_ON_FIRST_USE } from "./helpers/headless-first-use-packages";

// Loading the bundle in a child gives it a fresh require cache, so the
// result is what an Outpost process loads, whatever this worker already has.
const PROBE = `
  require(process.argv[1]);
  const packages = new Set();
  for (const file of Object.keys(require.cache)) {
    const parts = file.split(require("node:path").sep);
    const at = parts.lastIndexOf("node_modules");
    if (at < 0) continue;
    packages.add(parts[at + 1].startsWith("@") ? parts[at + 1] + "/" + parts[at + 2] : parts[at + 1]);
  }
  process.stdout.write(JSON.stringify([...packages]));
  process.exit(0);
`;

let root: string | undefined;
let bundle: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pa-startup-imports-"));
  await buildHeadless({ outputDirectory: path.join(root, "dist") });
  bundle = path.join(root, "dist/index.js");
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it("loading the built headless owner defers the packages it needs only on first use", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", PROBE, bundle], {
    env: { ...process.env, PWRAGENT_HOME: path.join(root!, "home") },
  });
  const loaded = JSON.parse(stdout) as string[];
  // The probe saw the owner's real dependency graph, so an absence means something.
  expect(loaded).toContain("better-sqlite3");
  expect(loaded.filter(name => LOADED_ON_FIRST_USE.includes(name))).toEqual([]);
});
