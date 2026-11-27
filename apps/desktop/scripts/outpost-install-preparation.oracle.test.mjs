import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { runNativeFixtureCommand } from "../src/test-setup/native-helper-fixture";

// This is a coordination model around the actual installer and actual Worker
// lifecycle. Native output and all real Git probes have separate runtime oracles.
it("starts both preparations and joins the remaining owner when either one fails", async ({ signal, onTestFinished }) => {
  for (const failure of ["none", "native", "git"]) {
    const root = mkdtempSync(join(tmpdir(), "outpost-preparation-model-"));
    const scripts = join(root, "scripts");
    mkdirSync(scripts);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/runtime.json"), "{}");
    copyFileSync(fileURLToPath(new URL("../../../packages/pwragent/scripts/install.mjs", import.meta.url)), join(scripts, "install.mjs"));
    const nativeGate = join(root, "native.release");
    const gitGate = join(root, "git.release");
    const watchers = [];
    let outcome;
    onTestFinished(async () => {
      // A failed or timed-out assertion must release and join its real process
      // group/Windows Job before deleting the input and output fixtures.
      writeFileSync(nativeGate, "");
      writeFileSync(gitGate, "");
      if (outcome) await outcome;
      for (const watcher of watchers) watcher.close();
      rmSync(root, { recursive: true, force: true });
    });
    const shared = `
      import fs from "node:fs";
      import path from "node:path";
      const root = ${JSON.stringify(root)};
      const failure = ${JSON.stringify(failure)};
      const mark = name => fs.writeFileSync(path.join(root, name), "");
      const present = name => fs.existsSync(path.join(root, name));
    `;
    writeFileSync(join(scripts, "build-mcp-ipc-relay.mjs"), shared + `
      const pause = new Int32Array(new SharedArrayBuffer(4));
      const wait = name => { while (!present(name)) Atomics.wait(pause, 0, 0, 5); };
      export function buildMcpIpcRelay(options) {
        mark("native.started");
        if (failure === "native") { mark("native.failed"); mark("native.ended"); throw new Error("modeled native failure"); }
        if (failure === "git") { wait("git.failed"); mark("native.joining"); }
        wait("native.release");
        fs.writeFileSync(options.destination, "modeled helper");
        mark("native.ended");
        return options.destination;
      }
    `);
    writeFileSync(join(scripts, "build-mcp-stdio-relay.mjs"), shared + `
      export function buildMcpStdioRelay() { mark("stdio.ended"); }
    `);
    writeFileSync(join(scripts, "stage-runtime.mjs"), shared + `
      import { setTimeout } from "node:timers/promises";
      const wait = async name => { while (!present(name)) await setTimeout(5); };
      export async function stageRuntime() {
        mark("git.started");
        if (failure === "git") { mark("git.failed"); mark("git.ended"); throw new Error("modeled Git failure"); }
        if (failure === "native") { await wait("native.failed"); mark("git.joining"); }
        await wait("git.release");
        mark("git.ended");
      }
    `);
    const entry = join(scripts, "install.mjs");
    const args = failure === "none"
      ? ["--max-old-space-size=512", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(entry).href)});`]
      : [entry];
    outcome = runNativeFixtureCommand(process.execPath, args).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    if (process.platform === "win32") {
      const result = await outcome;
      expect(result.ok).toBe(false);
      expect(result.error.message).toContain("Outpost supports Linux and macOS");
      expect(existsSync(join(root, "native.started"))).toBe(false);
      expect(existsSync(join(root, "git.started"))).toBe(false);
      continue;
    }
    const ready = (names) => new Promise((resolve, reject) => {
      const check = () => { if (names.every((name) => existsSync(join(root, name)))) { watcher.close(); resolve(); } };
      const watcher = watch(root, check);
      watchers.push(watcher);
      check();
      void outcome.then((result) => reject(new Error(`Installer exited before the preparation barrier: ${result.error?.message ?? "success"}`)));
    });
    const names = ["native.started", "git.started"];
    if (failure === "native") names.push("git.joining");
    if (failure === "git") names.push("native.joining");
    await ready(names);
    signal.throwIfAborted();
    // The remaining preparation is still gated, even after its sibling failed.
    expect(existsSync(join(root, failure === "native" ? "git.ended" : "native.ended"))).toBe(false);
    writeFileSync(nativeGate, "");
    writeFileSync(gitGate, "");
    const result = await outcome;
    signal.throwIfAborted();
    expect(result.ok).toBe(failure === "none");
    if (failure !== "none") expect(result.error.message).toContain(failure === "native" ? "modeled native failure" : "modeled Git failure");
    expect(existsSync(join(root, "native.ended"))).toBe(true);
    expect(existsSync(join(root, "stdio.ended"))).toBe(failure !== "native");
    expect(existsSync(join(root, "git.ended"))).toBe(true);
  }
});
