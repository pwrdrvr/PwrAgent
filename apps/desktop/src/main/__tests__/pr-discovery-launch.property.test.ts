import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import * as gitExecutable from "../app-server/git-executable";
import { GitSubprocessDiagnostics, prGitSubprocessCaller } from "../diagnostics/git-subprocess-diagnostics";
import { resolvePrLookupBranches } from "../pr-status/pr-detection";
import * as prMetadataProcess from "../pr-status/pr-metadata-process";
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
      blockers.push(prMetadataProcess.runPrMetadataProcess(async () => {
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

async function holdMetadataAdmission() {
  const admissionFull = Promise.withResolvers<void>();
  const releaseAdmission = Promise.withResolvers<void>();
  let occupiedSlots = 0;
  const blockers = Array.from({ length: 8 }, () => prMetadataProcess.runPrMetadataProcess(async () => {
    if (++occupiedSlots === 8) admissionFull.resolve();
    await releaseAdmission.promise;
  }));
  await admissionFull.promise;
  return { blockers, releaseAdmission: releaseAdmission.resolve };
}

async function expectQueuedProbePerContext(contexts: number[]): Promise<void> {
  const cwd = path.join(os.tmpdir(), "fixture-checkout");
  const { blockers, releaseAdmission } = await holdMetadataAdmission();

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
    releaseAdmission();
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

const callers = ["pr-scheduled-prefetch", "pr-live-branch-lookup", "pr-stored-attachment-validation"] as const;

it.each(callers)("credits a shared queued remote HEAD probe to %s when it arrives first", async (initiator) => {
  const cwd = path.join(os.tmpdir(), "fixture-shared-checkout");
  const diagnostics = new GitSubprocessDiagnostics(() => 0);
  const { blockers, releaseAdmission } = await holdMetadataAdmission();
  const probeQueued = Promise.withResolvers<void>();
  const runPrMetadataGit = prMetadataProcess.runPrMetadataGit;
  const enqueue = vi.spyOn(prMetadataProcess, "runPrMetadataGit").mockImplementation((...args) => {
    const result = runPrMetadataGit(...args);
    probeQueued.resolve();
    return result;
  });
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (checkout, args, options) => {
    diagnostics.startGit(checkout, args, options?.purpose)(false);
    return { stdout: "origin/main\n", stderr: "" };
  });
  const { background, selected } = prMetadataProcess.PR_METADATA_PRIORITY;
  const read = (caller: typeof callers[number], priority: number) =>
    prGitSubprocessCaller.run(caller, () => readGitRemoteHead(cwd, "origin", { priority: () => priority }));
  const lookups = [read(initiator, background)];
  try {
    await Promise.race([probeQueued.promise, lookups[0].then(() => {
      throw new Error("The initiating lookup completed before it queued a Git probe");
    })]);
    for (const caller of callers) {
      if (caller !== initiator) lookups.push(read(caller, selected));
    }
    expect(runner).not.toHaveBeenCalled();
    releaseAdmission();

    expect(await Promise.all(lookups)).toEqual(callers.map(() => "origin/main"));
    // A queued read of one checkout and ref launches once. Later readers
    // may raise its priority, while the initiating caller owns the start.
    expect(runner.mock.calls.map(([checkout, args]) => [checkout, args])).toEqual([
      [cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]],
    ]);
    const [bucket] = diagnostics.snapshot().buckets;
    expect(bucket.startsByCaller).toEqual(Object.fromEntries(callers.map((caller) =>
      [caller, Number(caller === initiator)],
    )));
  } finally {
    releaseAdmission();
    await Promise.allSettled([...blockers, ...lookups]);
    runner.mockRestore();
    enqueue.mockRestore();
  }
});
