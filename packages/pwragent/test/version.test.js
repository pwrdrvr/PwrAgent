import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatVersion, restartRequired, versionInfo } from "../src/version.js";
import { setup } from "./helpers.js";

// PWRAGENT_TEST_CLI points at an installed package; expect its own manifest.
const cli = process.env.PWRAGENT_TEST_CLI || fileURLToPath(new URL("../bin/pwragent.js", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(path.dirname(cli), "../package.json"), "utf8"));
const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("--version and version print the package manifest's version without a daemon", () => {
  const flag = run(["--version"]);
  assert.equal(flag.status, 0, flag.stderr);
  assert.equal(flag.stdout.trim(), formatVersion(versionInfo(manifest)));
  assert.match(flag.stdout, new RegExp(`^pwragent ${manifest.version.replaceAll(".", "\\.")}\\b`));
  // An invalid profile or missing daemon must not stop a version check.
  const command = run(["version"], { PWRAGENT_PROFILE: "../bad" });
  assert.equal(command.status, 0, command.stderr);
  assert.deepEqual(JSON.parse(command.stdout), versionInfo(manifest));
  assert.match(run(["--help"]).stdout, /pwragent --version \| version/);
  const badFlags = run(["version", "--id", "x"]);
  assert.equal(badFlags.status, 1);
  assert.match(badFlags.stderr, /--id does not apply to version/);
});

test("release metadata adds the tag and commit; malformed metadata is ignored", () => {
  const commit = "a".repeat(40);
  const released = versionInfo({ name: "pwragent", version: "1.3.8", pwragentRelease: { tag: "v1.3.8", commit } });
  assert.deepEqual(released, { name: "pwragent", version: "1.3.8", release: { tag: "v1.3.8", commit } });
  assert.equal(formatVersion(released), `pwragent 1.3.8 (v1.3.8, commit ${commit})`);
  const checkout = versionInfo({ name: "pwragent", version: "1.3.8" });
  assert.deepEqual(checkout, { name: "pwragent", version: "1.3.8" });
  assert.equal(formatVersion(checkout), "pwragent 1.3.8");
  assert.deepEqual(versionInfo({ name: "pwragent", version: "1.3.8", pwragentRelease: { tag: 7, commit: null } }), checkout);
});

test("restartRequired compares the running daemon with the installed package", () => {
  const installed = { version: "1.3.8", release: { tag: "v1.3.8", commit: "a".repeat(40) } };
  assert.equal(restartRequired(structuredClone(installed), installed), false);
  assert.equal(restartRequired(undefined, installed), true);
  assert.equal(restartRequired({ ...installed, version: "1.3.7" }, installed), true);
  assert.equal(restartRequired({ ...installed, release: { ...installed.release, commit: "b".repeat(40) } }, installed), true);
  assert.equal(restartRequired({ version: "1.3.8" }, { version: "1.3.8" }), false);
});

test("status reports the running daemon's version beside the installed one", { timeout: 10000 }, async (t) => {
  const h = await setup(t);
  const { name: _name, ...expected } = versionInfo(manifest);
  assert.equal(JSON.parse(h.daemon.output.split("\n").find((line) => line.includes("\"ready\":true"))).version, manifest.version);
  const client = h.launch(["status"]);
  assert.equal((await client.done).code, 0, client.errors);
  const status = JSON.parse(client.output);
  assert.deepEqual(status.running, expected);
  assert.deepEqual(status.installed, expected);
  assert.equal(status.restartRequired, false);
});
