import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type TestContext } from "vitest";

type TestLifetime = Pick<TestContext, "signal" | "onTestFinished">;
type FixtureScope = (run: () => Promise<void>) => Promise<void>;

export function checkOwnerParity<Host extends { close(): Promise<void> }>(
  { signal, onTestFinished }: TestLifetime,
  startOwners: ReadonlyArray<() => Promise<Host>>,
  check: (host: Host) => Promise<void>,
  withFixture: FixtureScope = (run) => run(),
): Promise<void> {
  const runOwners = async () => {
    signal.throwIfAborted();
    // Isolated owners can complete independently. Join both branches even
    // when startup or an assertion fails, before closing the fixture scope.
    const results = await Promise.allSettled(startOwners.map(async (start) => {
      const host = await start();
      try {
        signal.throwIfAborted();
        await check(host);
      } finally {
        await host.close();
      }
    }));
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Both owner parity checks failed");
  };
  // Vitest can move on from a timed-out body while its async work is still
  // running. Register the join before even the fixture setup can start.
  const running = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return withFixture(runOwners);
  });
  onTestFinished(async () => { await running.catch(() => undefined); });
  return running;
}

export async function withAmbientShellCanary(signal: AbortSignal, run: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-ambient-shell-"));
  try {
    signal.throwIfAborted();
    const shell = path.join(root, "ambient-shell");
    await writeFile(shell, '#!/bin/sh\n: > "${0%/*}/invoked"\nexec /bin/sh -c "$2"\n', { mode: 0o700, signal });
    signal.throwIfAborted();
    const inheritedShell = process.env.SHELL;
    process.env.SHELL = shell;
    try {
      await run();
      // Codex discovery should only run the Outpost fixture's own shell.
      expect(existsSync(path.join(root, "invoked"))).toBe(false);
    } finally {
      if (inheritedShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = inheritedShell;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
