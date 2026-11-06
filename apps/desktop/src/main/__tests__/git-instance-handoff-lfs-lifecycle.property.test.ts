import path from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("vitest");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("../app-server/git-executable");
  vi.doUnmock("@pwragent/federation/git-instance-handoff");
  vi.resetModules();
});

// Run the actual test declaration with a runner model. A deadline releases
// Vitest's wait for a callback; it does not cancel that callback's promises.
// Gate one Git completion so the model can begin afterAll while work remains.
async function checkLifecycle(blockAt: number, fail: boolean, setupCompletionMs?: number): Promise<void> {
  const setupHooks: { callback: () => Promise<unknown>; timeout?: number }[] = [];
  const cleanupHooks: (() => Promise<unknown>)[] = [];
  let body!: () => Promise<unknown>;
  let bodyStarted = false;
  let deadline = false;
  let preparedInBody = false;
  let commandCount = 0;
  const events: string[] = [];
  const reached = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  const failure = new Error("fixture Git failed");
  const root = path.join(path.sep, "fixture");
  const payload = Buffer.from("published feature\0binary\r\n");
  const runGit = async (_cwd: string, args: string[]) => {
    const index = commandCount++;
    // The seed is 14 Git commands. None belongs to the handoff deadline.
    if (index < 14 && bodyStarted) preparedInBody = true;
    if (index === blockAt) {
      reached.resolve();
      await completion.promise;
      if (fail) throw failure;
    }
    return { stdout: args[0] === "branch" ? "feature/lfs-handoff\n" : "", stderr: "" };
  };
  vi.doMock("vitest", async (importOriginal) => ({
    ...await importOriginal<typeof import("vitest")>(),
    beforeAll: (callback: () => Promise<unknown>, timeout?: number) => setupHooks.push({ callback, timeout }),
    afterAll: (callback: () => Promise<unknown>) => cleanupHooks.push(callback),
    it: (_name: string, callback: () => Promise<unknown>, timeout: number) => {
      expect(timeout).toBe(20_000);
      body = callback;
    },
  }));
  vi.doMock("node:fs/promises", () => ({
    mkdtemp: async () => root,
    realpath: async (value: string) => value,
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    cp: async () => undefined,
    readFile: async () => payload,
    readdir: async () => [".git", ".gitattributes", "asset.bin"],
    rm: async (value: string) => {
      expect(value).toBe(root);
      events.push("root-removed");
    },
  }));
  vi.doMock("../app-server/git-executable", () => ({ runGitCommand: runGit }));
  vi.doMock("@pwragent/federation/git-instance-handoff", () => ({
    createGitHandoffService: (git: typeof runGit) => ({
      exportGitHandoff: async (cwd: string) => {
        await git(cwd, ["rev-parse", "HEAD"]);
        return { sourceBranch: "feature/lfs-handoff" };
      },
      importGitHandoff: async ({ repository }: { repository: string }) => {
        await git(repository, ["worktree", "add"]);
        return async () => undefined;
      },
    }),
  }));
  vi.resetModules();
  await import("./git-instance-handoff-lfs.test");
  const invoke = async (callback: () => Promise<unknown>) => {
    try {
      await callback();
    } finally {
      events.push("callback-settled");
    }
  };
  const invokeSetup = async (hook: typeof setupHooks[number]) => {
    if (setupCompletionMs === undefined) return await invoke(hook.callback);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        invoke(hook.callback),
        new Promise<never>((_resolve, reject) => {
          // Match the POSIX runner's default when the declaration omits a
          // budget. Fake time exercises the deadline without an 11s sleep.
          timer = setTimeout(() => reject(new Error("fixture setup deadline exceeded")), hook.timeout ?? 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const run = (async () => {
    for (const hook of setupHooks) await invokeSetup(hook);
    if (!deadline) {
      bodyStarted = true;
      await invoke(body);
    }
  })().then(
    () => undefined,
    (error: unknown) => error,
  );
  await reached.promise;
  events.length = 0;
  const shutdown = async () => {
    for (const hook of cleanupHooks) await hook();
    events.push("worker-released");
  };
  if (setupCompletionMs !== undefined) {
    await vi.advanceTimersByTimeAsync(setupCompletionMs);
    completion.resolve();
    const error = await run;
    await shutdown();
    const withinBudget = setupCompletionMs < 20_000;
    if (withinBudget) expect(error).toBeUndefined();
    else expect(error).toMatchObject({ message: "fixture setup deadline exceeded" });
    expect(bodyStarted).toBe(withinBudget);
    expect({ preparedInBody, events }).toEqual({
      preparedInBody: false,
      events: [
        "callback-settled",
        ...(withinBudget ? ["callback-settled"] : []),
        "root-removed",
        "worker-released",
      ],
    });
    return;
  }
  deadline = true;
  // Simulate either a setup deadline or a test deadline. The worker must
  // retain the pending callback and its root until the Git completion drains.
  const closing = shutdown();
  completion.resolve();
  const error = await run;
  await closing;
  expect(error).toBe(fail ? failure : undefined);
  expect({ preparedInBody, events }).toEqual({
    preparedInBody: false,
    events: ["callback-settled", "root-removed", "worker-released"],
  });
}

it("runs the handoff after an 11-second fixture preparation", async () => {
  vi.useFakeTimers();
  await checkLifecycle(13, false, 11_000);
});

it("preserves the original setup deadline for generated completions within and beyond 20 seconds", async () => {
  vi.useFakeTimers();
  await fc.assert(fc.asyncProperty(
    fc.oneof(
      fc.integer({ min: 10_001, max: 19_999 }),
      fc.integer({ min: 20_001, max: 29_999 }),
    ),
    async (elapsedMs) => { await checkLifecycle(13, false, elapsedMs); },
  ));
});

it.each([13, 15])("keeps a timed-out callback owned through Git completion %i", async (blockAt) => {
  await checkLifecycle(blockAt, false);
});

it("owns setup and handoff work through generated late completions and failures", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 18 }),
    fc.boolean(),
    async (blockAt, fail) => { await checkLifecycle(blockAt, fail); },
  ));
});
