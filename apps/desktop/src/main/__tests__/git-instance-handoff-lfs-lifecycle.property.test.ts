import path from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("vitest");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("../app-server/git-executable");
  vi.doUnmock("@pwragent/federation/git-instance-handoff");
  vi.resetModules();
});

// Run the actual test declaration with a runner model. A deadline releases
// Vitest's wait for a callback; it does not cancel that callback's promises.
// Gate one Git completion so the model can begin afterAll while work remains.
async function checkLifecycle(blockAt: number, fail: boolean): Promise<void> {
  const setupHooks: (() => Promise<unknown>)[] = [];
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
    beforeAll: (callback: () => Promise<unknown>) => setupHooks.push(callback),
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
  const run = (async () => {
    for (const hook of setupHooks) await invoke(hook);
    if (!deadline) {
      bodyStarted = true;
      await invoke(body);
    }
  })().then(
    () => undefined,
    (error: unknown) => error,
  );
  await reached.promise;
  deadline = true;
  events.length = 0;
  // Simulate either a setup deadline or a test deadline. The worker must
  // retain the pending callback and its root until the Git completion drains.
  const shutdown = (async () => {
    for (const hook of cleanupHooks) await hook();
    events.push("worker-released");
  })();
  completion.resolve();
  const error = await run;
  await shutdown;
  expect(error).toBe(fail ? failure : undefined);
  expect({ preparedInBody, events }).toEqual({
    preparedInBody: false,
    events: ["callback-settled", "root-removed", "worker-released"],
  });
}

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
