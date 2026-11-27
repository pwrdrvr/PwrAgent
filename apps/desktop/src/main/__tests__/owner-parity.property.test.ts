import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi, type TestContext } from "vitest";
import { checkOwnerParity, withAmbientShellCanary } from "./helpers/owner-parity";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, mkdtemp: vi.fn(original.mkdtemp) };
});

function testLifetime() {
  const controller = new AbortController();
  const onTestFinished = vi.fn<TestContext["onTestFinished"]>();
  return { controller, signal: controller.signal, onTestFinished };
}

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
