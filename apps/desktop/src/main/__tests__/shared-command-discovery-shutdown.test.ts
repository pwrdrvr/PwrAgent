import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
beforeEach(() => vi.resetModules());
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("shared command discovery shutdown", () => {
  it("drains a real probe started outside Settings through actual child and stdio close", async () => {
    const { buildCommandDiscoveryCandidate, closeSharedCommandDiscovery } =
      await import("../settings/command-discovery");
    const root = await mkdtemp(path.join(os.tmpdir(), "shared-command-probe-"));
    roots.push(root);
    const release = path.join(root, "release");
    const ready = deferred();
    let child: ChildProcess | undefined;
    let childClosed = false;
    const spawned = channel("child_process");
    const onSpawn = (message: unknown) => {
      const candidate = (message as { process?: unknown })?.process;
      if (!(candidate instanceof ChildProcess)) return;
      candidate.once("spawn", () => {
        if (!candidate.spawnargs.includes(release)) return;
        child = candidate;
        candidate.stdout!.once("data", () => ready.resolve());
        candidate.once("close", () => { childClosed = true; ready.resolve(); });
      });
    };
    spawned.subscribe(onSpawn);
    const running = buildCommandDiscoveryCandidate(
      { command: process.execPath, source: "config" },
      {
        env: process.env,
        versionArgs: ["-e", "process.stdout.write('ready'); const t=setInterval(()=>{if(require('fs').existsSync(process.argv[1])){clearInterval(t);process.stdout.write('finished');}},10)", release],
        parseVersion: (output) => output,
      },
    );
    try {
      // The native child announces readiness; elapsed time is not readiness.
      await Promise.race([ready.promise, running.then(() => { throw new Error("Probe completed before readiness"); })]);
      expect(child?.pid).toBeDefined();
      let drained = false;
      const closing = closeSharedCommandDiscovery();
      void closing.then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(childClosed).toBe(false);
      expect(child?.exitCode).toBeNull();
      await writeFile(release, "release");
      // A result completed during quit cannot authorize a follow-up command.
      expect(await running).toBeUndefined();
      await closing;
      expect(childClosed).toBe(true);
      expect(child?.exitCode).toBe(0);
      expect(child?.signalCode).toBeNull();
      expect(closeSharedCommandDiscovery()).toBe(closing);
    } finally {
      await writeFile(release, "release");
      await running;
      await closeSharedCommandDiscovery();
      spawned.unsubscribe(onSpawn);
    }
  });

  it("closes admission while a caller without its own signal awaits preflight", async () => {
    const { buildCommandDiscoveryCandidate, closeSharedCommandDiscovery, discoverCommands } =
      await import("../settings/command-discovery");
    const root = await mkdtemp(path.join(os.tmpdir(), "shared-command-admission-"));
    roots.push(root);
    const marker = path.join(root, "launched");
    const entered = deferred();
    const release = deferred();
    const running = buildCommandDiscoveryCandidate(
      { command: process.execPath, source: "config" },
      {
        env: process.env,
        versionArgs: ["-e", "require('fs').writeFileSync(process.argv[1], 'launched')", marker],
        parseVersion: (output) => output,
        preflightCandidate: async () => {
          entered.resolve();
          await release.promise;
          return undefined;
        },
      },
    );
    try {
      await entered.promise;
      let drained = false;
      const closing = closeSharedCommandDiscovery().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      release.resolve();
      expect(await running).toBeUndefined();
      await closing;
      let admitted = false;
      const snapshot = await discoverCommands({
        env: process.env,
        fixedCandidates: [{ command: process.execPath, source: "config" }],
        autoCandidates: [{ command: process.execPath, source: "path" }],
        parseVersion: (output) => output,
        preflightCandidate: async () => { admitted = true; return undefined; },
      });
      expect(snapshot).toEqual({ candidates: [] });
      expect(admitted).toBe(false);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
      await running;
      await closeSharedCommandDiscovery();
    }
  });
});
