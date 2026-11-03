import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandDiscoveryLifetime } from "../settings/command-discovery-lifetime";
import { buildCommandDiscoveryCandidate } from "../settings/command-discovery";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("command discovery shutdown ownership", () => {
  it("rejects a version launch resumed from a preflight after close", async () => {
    const owner = new CommandDiscoveryLifetime();
    const entered = deferred();
    const release = deferred();
    const root = await mkdtemp(path.join(os.tmpdir(), "command-discovery-close-"));
    roots.push(root);
    const marker = path.join(root, "launched");
    const operation = owner.run(() => buildCommandDiscoveryCandidate(
      { command: process.execPath, source: "config" },
      {
        env: process.env,
        signal: owner.signal,
        versionArgs: ["-e", "require('fs').writeFileSync(process.argv[1], 'launched')", marker],
        parseVersion: (output) => output,
        preflightCandidate: async () => {
          entered.resolve();
          await release.promise;
          return undefined;
        },
      },
    ), undefined);
    await entered.promise;
    const closing = owner.close();
    release.resolve();
    await closing;
    expect(await operation).toBeUndefined();
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    let admitted = false;
    expect(await owner.run(async () => { admitted = true; return 1; }, 0)).toBe(0);
    expect(admitted).toBe(false);
    expect(owner.close()).toBe(closing);
  });

  it("drains every in-flight cache generation without killing its active probe", async () => {
    const owner = new CommandDiscoveryLifetime();
    const first = deferred();
    const second = deferred();
    const firstRun = owner.run(() => first.promise, undefined);
    const secondRun = owner.run(() => second.promise, undefined);
    let closed = false;
    const closing = owner.close().then(() => { closed = true; });
    first.resolve();
    await firstRun;
    expect(closed).toBe(false);
    second.resolve();
    await secondRun;
    await closing;
    expect(closed).toBe(true);
  });

  it("keeps close pending until a real probe exits and closes its stdio", async () => {
    const owner = new CommandDiscoveryLifetime();
    const root = await mkdtemp(path.join(os.tmpdir(), "command-discovery-child-"));
    roots.push(root);
    const release = path.join(root, "release");
    const script = "process.stdout.write('ready'); const t=setInterval(()=>{if(require('fs').existsSync(process.argv[1])){clearInterval(t);process.stdout.write('finished');}},10)";
    const ready = deferred();
    let childClosed = false;
    const running = owner.run(() => new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, ["-e", script, release], { env: process.env }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
      child.stdout!.once("data", () => ready.resolve());
      child.once("close", () => { childClosed = true; });
    }), "");
    await ready.promise;
    let closed = false;
    const closing = owner.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(childClosed).toBe(false);
    await writeFile(release, "release");
    expect(await running).toBe("readyfinished");
    await closing;
    expect(childClosed).toBe(true);
  });
});
