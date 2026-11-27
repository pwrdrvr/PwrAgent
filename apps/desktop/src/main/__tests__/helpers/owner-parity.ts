import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type TestContext } from "vitest";

type TestLifetime = Pick<TestContext, "signal" | "onTestFinished">;
type FixtureScope = (run: () => Promise<void>) => Promise<void>;
type OwnerCheck<Host> = (host: Host) => Promise<void>;

function runOwnerParity<Host extends { close(): Promise<void> }>(
  signal: AbortSignal,
  startOwners: ReadonlyArray<() => Promise<Host>>,
  check: OwnerCheck<Host>,
  withFixture: FixtureScope,
  onStarting?: (owners: Promise<Host>[]) => void,
): Promise<void> {
  const runOwners = async () => {
    signal.throwIfAborted();
    const starting = startOwners.map(async (start) => start());
    onStarting?.(starting);
    // Isolated owners can complete independently. Join both branches even
    // when startup or an assertion fails, before closing the fixture scope.
    const results = await Promise.allSettled(starting.map(async (owner) => {
      const host = await owner;
      try {
        signal.throwIfAborted();
        await check(host);
      } finally {
        await host.close();
      }
    }));
    // A cancelled sibling can propagate the original startup failure.
    const failures = [...new Set(results.filter((result) => result.status === "rejected").map((result) => result.reason))];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Both owner parity checks failed");
  };
  return Promise.resolve().then(() => {
    signal.throwIfAborted();
    return withFixture(runOwners);
  });
}

export function checkOwnerParity<Host extends { close(): Promise<void> }>(
  { signal, onTestFinished }: TestLifetime,
  startOwners: ReadonlyArray<() => Promise<Host>>,
  check: OwnerCheck<Host>,
  withFixture: FixtureScope = (run) => run(),
): Promise<void> {
  const running = runOwnerParity(signal, startOwners, check, withFixture);
  // Vitest can move on from a timed-out body while its async work is still
  // running. Register the join before even the fixture setup can start.
  onTestFinished(async () => { await running.catch(() => undefined); });
  return running;
}

/** Starts isolated owners in the setup hook, then exercises them in the test. */
export function prepareOwnerParity<Host extends { close(): Promise<void> }>(
  { signal, onTestFinished }: TestLifetime,
  startOwners: ReadonlyArray<(signal: AbortSignal) => Promise<Host>>,
  withFixture: FixtureScope,
) {
  const startup = new AbortController();
  const fixtureSignal = AbortSignal.any([signal, startup.signal]);
  const ready = Promise.withResolvers<void>();
  const exercise = Promise.withResolvers<OwnerCheck<Host> | undefined>();
  const running = runOwnerParity(fixtureSignal, startOwners.map((start) => () => start(fixtureSignal)), async (host) => {
    const check = await exercise.promise;
    fixtureSignal.throwIfAborted();
    await check?.(host);
  }, withFixture, (starting) => {
    void Promise.all(starting).then(() => {
      if (!fixtureSignal.aborted) ready.resolve();
    }, (error: unknown) => {
      startup.abort(error);
      exercise.resolve(undefined);
    });
  });
  // Report a startup failure only after both branches and the shell scope
  // have closed. Vitest starts its cleanup deadline when setup rejects.
  void running.catch(ready.reject);
  onTestFinished(async () => {
    // Setup can fail or time out before the test has supplied its checks.
    // Release the ready branch so it can close alongside a late-starting owner.
    exercise.resolve(undefined);
    await running.catch(() => undefined);
  });
  return {
    ready: ready.promise,
    check: (check: OwnerCheck<Host>) => {
      exercise.resolve(check);
      return running;
    },
  };
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
