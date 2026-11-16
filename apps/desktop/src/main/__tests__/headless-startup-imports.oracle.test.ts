import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildHeadless } from "../../../scripts/build-headless.mjs";
import { LOADED_ON_FIRST_USE } from "./helpers/headless-first-use-packages";

// Loading the bundle in a child gives it fresh CJS and ESM caches, so the
// result is what an Outpost process loads, whatever this worker already has.
const PROBE = `
  const files = new Set();
  const hook = require("node:module").registerHooks({ load(url, context, nextLoad) {
    if (url.startsWith("file:")) files.add(require("node:url").fileURLToPath(url));
    return nextLoad(url, context);
  } });
  require(process.argv[1]);
  hook.deregister();
  const packages = new Set();
  for (const file of files) {
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
  await buildHeadless({ outputDirectory: path.join(root, "dist"), sourcemap: false, logLevel: "warning" });
  bundle = path.join(root, "dist/index.js");
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it("the startup probe build emits executable bundles without debugging source maps", () => {
  const files = fs.readdirSync(path.dirname(bundle));
  expect(files).toContain("index.js");
  expect(files.filter(file => file.endsWith(".map"))).toEqual([]);
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
