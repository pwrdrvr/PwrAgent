import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi, type TestContext } from "vitest";
import { checkOwnerParity, prepareOwnerParity, withAmbientShellCanary } from "./helpers/owner-parity";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, mkdtemp: vi.fn(original.mkdtemp) };
});

function testLifetime() {
  const controller = new AbortController();
  const onTestFinished = vi.fn<TestContext["onTestFinished"]>();
  return { controller, signal: controller.signal, onTestFinished };
}

it("keeps both prepared owners open until the test supplies the checks", async () => {
  const context = testLifetime();
  const desktop = { close: vi.fn(async () => {}) };
  const outpost = { close: vi.fn(async () => {}) };
  const starting = Promise.withResolvers<typeof outpost>();
  const firstStarted = Promise.withResolvers<void>();
  const fixture = prepareOwnerParity(context, [
    async () => { firstStarted.resolve(); return desktop; },
    () => starting.promise,
  ], (run) => run());
  let ready = false;
  const prepared = fixture.ready.then(() => { ready = true; });
  await firstStarted.promise;
  await setImmediate();
  const waitedForOutpost = !ready;
  starting.resolve(outpost);
  await prepared;

  const check = vi.fn(async (owner: typeof desktop) => {
    expect(owner.close).not.toHaveBeenCalled();
  });
  await fixture.check(check);
  expect(waitedForOutpost).toBe(true);
  expect(check.mock.calls.flat()).toEqual(expect.arrayContaining([desktop, outpost]));
  expect(check).toHaveBeenCalledTimes(2);
  expect(desktop.close).toHaveBeenCalledOnce();
  expect(outpost.close).toHaveBeenCalledOnce();
});

it("cancels and drains Outpost startup before reporting a desktop startup failure", async () => {
  const context = testLifetime();
  const inheritedShell = process.env.SHELL;
  const desktop = Promise.withResolvers<never>();
  const outpost = Promise.withResolvers<never>();
  const outpostEntered = Promise.withResolvers<void>();
  const startOutpost = vi.fn((signal?: AbortSignal) => {
    expect(signal?.aborted).not.toBe(true);
    outpostEntered.resolve();
    return outpost.promise;
  });
  const fixture = prepareOwnerParity(context, [() => desktop.promise, startOutpost],
    (run) => withAmbientShellCanary(context.signal, run));
  let settled = false;
  const outcome = fixture.ready.catch((error: unknown) => error).finally(() => { settled = true; });
  await outpostEntered.promise;
  const failure = new Error("Desktop could not start");
  desktop.reject(failure);
  try {
    await setImmediate();
    expect(startOutpost.mock.calls[0]?.[0]?.reason).toBe(failure);
    expect(settled).toBe(false);
    expect(process.env.SHELL).not.toBe(inheritedShell);
  } finally {
    outpost.reject(failure);
    await context.onTestFinished.mock.lastCall?.[0](context as unknown as TestContext);
  }
  expect(await outcome).toBe(failure);
  expect(process.env.SHELL).toBe(inheritedShell);
});

it("drains prepared owners and restores the shell when setup is cancelled before the test runs", async () => {
  const context = testLifetime();
  const inheritedShell = process.env.SHELL;
  const firstStarted = Promise.withResolvers<void>();
  const desktopClosed = Promise.withResolvers<void>();
  const outpost = { close: vi.fn(async () => {}) };
  const starting = Promise.withResolvers<{ close(): Promise<void> }>();
  const fixture = prepareOwnerParity(context, [
    async () => {
      firstStarted.resolve();
      return { close: async () => { desktopClosed.resolve(); } };
    },
    () => starting.promise,
  ], (run) => withAmbientShellCanary(context.signal, run));
  const outcome = fixture.ready.catch((error: unknown) => error);
  await firstStarted.promise;
  const timeout = new Error("setup timed out");
  context.controller.abort(timeout);
  let finished = false;
  const join = Promise.resolve(context.onTestFinished.mock.lastCall?.[0](context as unknown as TestContext))
    .then(() => { finished = true; });
  try {
    await desktopClosed.promise;
    expect(finished).toBe(false);
    expect(process.env.SHELL).not.toBe(inheritedShell);
  } finally {
    starting.resolve(outpost);
    await join;
  }
  expect(outpost.close).toHaveBeenCalledOnce();
  expect(process.env.SHELL).toBe(inheritedShell);
  expect(await outcome).toBe(timeout);
});

it("retires shell setup cancelled during directory creation before admitting owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-parity-regression-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();
  const context = testLifetime();
  const inheritedShell = process.env.SHELL;
  const start = vi.fn(async () => ({ close: async () => {} }));
  vi.mocked(mkdtemp).mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });

  const running = checkOwnerParity(context, [start], async () => {}, (run) => withAmbientShellCanary(context.signal, run));
  const result = running.catch((error: unknown) => error);
  await entered.promise;
  const timeout = new Error("test timed out");
  context.controller.abort(timeout);
  const finished = context.onTestFinished.mock.lastCall?.[0](context as unknown as TestContext);
  release.resolve(root);
  await finished;
  expect(await result).toBe(timeout);
  expect(context.onTestFinished).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  expect(process.env.SHELL).toBe(inheritedShell);
  expect(existsSync(root)).toBe(false);
});

it("keeps the shell scoped until running and late-starting owners have closed", async () => {
  const context = testLifetime();
  const inheritedShell = process.env.SHELL;
  const closing = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  const lateStart = Promise.withResolvers<{ close(): Promise<void> }>();
  const lateClosed = Promise.withResolvers<void>();
  const check = vi.fn(async () => {});
  const running = checkOwnerParity(context, [
    async () => ({ close: async () => { closing.resolve(); await releaseClose.promise; } }),
    () => lateStart.promise,
  ], check, (run) => withAmbientShellCanary(context.signal, run));
  const result = running.catch((error: unknown) => error);
  await closing.promise;
  const timeout = new Error("test timed out");
  context.controller.abort(timeout);
  let finished = false;
  const join = Promise.resolve(context.onTestFinished.mock.lastCall?.[0](context as unknown as TestContext))
    .then(() => { finished = true; });
  lateStart.resolve({ close: async () => { lateClosed.resolve(); } });
  try {
    await lateClosed.promise;
    expect(process.env.SHELL).not.toBe(inheritedShell);
    expect(finished).toBe(false);
    expect(check).toHaveBeenCalledOnce();
  } finally {
    releaseClose.resolve();
    await Promise.all([join, result]);
  }
  expect(await result).toBe(timeout);
  expect(finished).toBe(true);
  expect(process.env.SHELL).toBe(inheritedShell);
});
