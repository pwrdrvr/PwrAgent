import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";

it("the actual Claude worker stops a pending SDK read when its owner IPC closes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-worker-owner-"));
  const entry = path.join(root, "worker.cjs");
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  await build({
    entryPoints: [path.resolve(import.meta.dirname, "../claude/claude-session-reader-worker.ts")],
    outfile: entry, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    plugins: [{ name: "owned-sdk-read", setup(builder) {
      builder.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({ path: "owned-sdk", namespace: "sdk-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "sdk-fixture" }, () => ({
        contents: `export const getSessionInfo = async () => {
          process.send({ phase: "reading" });
          setInterval(() => {}, 1000);
          return await new Promise(() => {});
        }; export const getSessionMessages = async () => []; export const getSubagentMessages = async () => [];`,
        loader: "js",
      }));
    } }],
  });
  const child = fork(entry, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = once(child, "exit");
  onTestFinished(() => { child.kill(); });
  const reading = once(child, "message");
  child.send({ id: 1, method: "getSessionInfo", sessionId: "invented-session" });
  expect((await reading)[0]).toEqual({ phase: "reading" });
  child.disconnect();
  expect((await closed)[0]).toBe(0);
});
