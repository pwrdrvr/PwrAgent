import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import * as gitExecutable from "../app-server/git-executable";
import { resolvePrLookupBranches } from "../pr-status/pr-detection";
import { runPrMetadataProcess } from "../pr-status/pr-metadata-process";
import { readGitRemoteHead } from "../pr-status/pr-remote-heads";

async function expectQueuedProbePerCheckout(groupSizes: number[]): Promise<void> {
  const requests = groupSizes.flatMap((count, group) => Array.from({ length: count }, (_, index) => ({
    cwd: path.join(os.tmpdir(), `fixture-checkout-${group}`),
    branch: index === 0 ? "main" : `topic-${index}`,
  })));
  const remotes = ["origin", "upstream", "east", "west"];
  const remotesStarted = Promise.withResolvers<void>();
  const finishRemotes = Promise.withResolvers<void>();
  const admissionFull = Promise.withResolvers<void>();
  const releaseAdmission = Promise.withResolvers<void>();
  let remoteStarts = 0;
  let occupiedSlots = 0;
  // The executor models this response without a repository on disk.
  // Disable the filesystem shortcut so all requests use the same Git oracle.
  vi.stubEnv("GIT_TEST_PR_DISCOVERY", "1");
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (_cwd, args) => {
    if (args[0] === "remote") {
      if (++remoteStarts === requests.length) remotesStarted.resolve();
      await finishRemotes.promise;
      return { stdout: remotes.join("\n"), stderr: "" };
    }
    if (args[0] === "symbolic-ref") throw new Error("Remote HEAD is absent");
    return { stdout: args[2] === "refs/heads/main" ? "refs/heads/main\n" : "", stderr: "" };
  });
  const lookups = Promise.all(requests.map(resolvePrLookupBranches));
  const blockers: Promise<void>[] = [];
  try {
    await remotesStarted.promise;
    for (let index = 0; index < 8; index++) {
      blockers.push(runPrMetadataProcess(async () => {
        if (++occupiedSlots === 8) admissionFull.resolve();
        await releaseAdmission.promise;
      }));
    }
    finishRemotes.resolve();
    await admissionFull.promise;
    releaseAdmission.resolve();

    expect(await lookups).toEqual(requests.map(({ branch }) => branch === "main" ? [] : [branch]));
    const starts = runner.mock.calls
      .filter(([, args]) => args[0] === "symbolic-ref")
      .map(([cwd, args]) => `${cwd}:${args[3]}`);
    const distinctCheckouts = new Set(requests.map(({ cwd }) => cwd));
    // Queueing the same unanswered command more than once should create one
    // Git start. A different checkout still needs its own answer.
    expect(starts.sort()).toEqual([...distinctCheckouts].flatMap((cwd) =>
      remotes.map((remote) => `${cwd}:refs/remotes/${remote}/HEAD`)).sort());
  } finally {
    finishRemotes.resolve();
    releaseAdmission.resolve();
    await Promise.allSettled([lookups, ...blockers]);
    runner.mockRestore();
    vi.unstubAllEnvs();
  }
}

it("shares queued remote HEAD probes for two branches of the same checkout", async () => {
  await expectQueuedProbePerCheckout([2]);
});

it("starts one queued remote HEAD probe per remote and exact checkout", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.integer({ min: 1, max: 2 }), { minLength: 1, maxLength: 4 }),
    expectQueuedProbePerCheckout,
  ), { numRuns: 30 });
});

async function expectQueuedProbePerContext(contexts: number[]): Promise<void> {
  const cwd = path.join(os.tmpdir(), "fixture-checkout");
  const admissionFull = Promise.withResolvers<void>();
  const releaseAdmission = Promise.withResolvers<void>();
  let occupiedSlots = 0;
  const blockers = Array.from({ length: 8 }, () => runPrMetadataProcess(async () => {
    if (++occupiedSlots === 8) admissionFull.resolve();
    await releaseAdmission.promise;
  }));
  await admissionFull.promise;

  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (_cwd, _args, options) => ({
    stdout: `origin/${path.basename(options?.env?.GIT_DIR ?? "")}\n`,
    stderr: "",
  }));
  const gitDirs = contexts.map((context) => path.join(os.tmpdir(), `git-context-${context}`));
  const lookups = gitDirs.map((gitDir) => {
    vi.stubEnv("GIT_DIR", gitDir);
    return readGitRemoteHead(cwd, "origin");
  });
  try {
    releaseAdmission.resolve();
    expect(await Promise.all(lookups)).toEqual(gitDirs.map((gitDir) => `origin/${path.basename(gitDir)}`));
    // All arrivals overlap before admission. The model has one launch per
    // distinct context, regardless of the order in which readers arrive.
    expect(runner.mock.calls.map(([, , options]) => options?.env?.GIT_DIR).sort())
      .toEqual([...new Set(gitDirs)].sort());
  } finally {
    await Promise.allSettled([...blockers, ...lookups]);
    runner.mockRestore();
    vi.unstubAllEnvs();
  }
}

it("joins the first queued context after an intervening context", async () => {
  await expectQueuedProbePerContext([0, 1, 0]);
});

it("starts one queued remote HEAD probe for each distinct Git context", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 3, maxLength: 12 }),
    expectQueuedProbePerContext,
  ), { numRuns: 30 });
});
