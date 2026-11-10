import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";

it("the shipped reader probe verifies the actual SDK worker through Node IPC", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reader-probe-oracle-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.resolve(import.meta.dirname, "../../..");
  const require = createRequire(import.meta.url);
  await build({
    entryPoints: [path.join(desktop, "src/main/claude/claude-session-reader-worker.ts")],
    outfile: path.join(root, "out/main/claude-session-reader-worker.js"),
    bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    plugins: [{ name: "installed-sdk", setup(builder) {
      builder.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, (args) => ({ path: require.resolve(args.path), external: true }));
    } }],
  });
  const probe = path.join(root, "scripts/probe.mjs");
  await build({
    entryPoints: [path.join(desktop, "scripts/electron-claude-session-reader-probe.mjs")], outfile: probe,
    bundle: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{ name: "windowless-node-test-host", setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: "host", namespace: "probe-test" }));
      builder.onLoad({ filter: /.*/, namespace: "probe-test" }, () => ({
        contents: `export const app = { setPath() {}, whenReady: () => Promise.resolve(), setActivationPolicy() {}, exit: code => { process.exitCode = code; } };
          export const utilityProcess = { fork() { throw new Error("The reader probe must use Node IPC, not utilityProcess"); } };`, loader: "js",
      }));
    } }],
  });
  const { stdout } = await promisify(execFile)(process.execPath, [probe], { env: { ...process.env, PWRAGENT_HOME: path.join(root, "home") } });
  expect(stdout).toContain("ok   messages in the project folder");
  expect(stdout).toContain("ok   messages in any project folder");
  expect(stdout).toContain("ok   session info");
  expect(stdout).toContain("the reader read the launch environment's sessions");
});
