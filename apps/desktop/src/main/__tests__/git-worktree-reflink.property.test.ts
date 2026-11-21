import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  WORKTREE_BUSY_UNKNOWN_REASON,
  WORKTREE_TURN_RUNNING_REASON,
  WorktreeReflinkOutputReader,
  WorktreeReflinkService,
  planWorktreeReflink,
} from "../git-worktree-reflink";
import {
  WorktreeReflinkCapabilityProbe,
  type GitRuntimeIdentity,
} from "../git-worktree-reflink-capabilities";
import {
  FAKE_GIT_HELP,
  FAKE_GIT_TRUTH,
  FAKE_GIT_VERSIONS,
  PWRGIT_2_DRY_RUN_PORCELAIN,
  type FakeGitVersion,
} from "./worktree-reflink-fixtures";

/** No turn is running in the worktree. */
const idle = async (): Promise<boolean> => false;
const capabilitiesArbitrary = fc.record({ reflink: fc.boolean(), verifyFilters: fc.boolean() });
const modeArbitrary = fc.constantFrom("estimate" as const, "share" as const);
const verifyArbitrary = fc.constantFrom(true, false, undefined);

describe("planWorktreeReflink", () => {
  it("keeps every estimate filter-free and passes --verify-filters only on an explicit, supported request", () => {
    fc.assert(fc.property(modeArbitrary, verifyArbitrary, capabilitiesArbitrary, (mode, verifyFilters, capabilities) => {
      const plan = planWorktreeReflink({ mode, verifyFilters, capabilities });
      if (!capabilities.reflink) {
        expect(plan).toEqual({ ok: false, reason: "no-reflink" });
        return;
      }
      if (mode === "share" && verifyFilters === true && !capabilities.verifyFilters) {
        // Asked to verify with a Git that cannot: refused, not run unverified.
        expect(plan).toEqual({ ok: false, reason: "no-verify-filters" });
        return;
      }
      if (!plan.ok) throw new Error(`unexpected refusal: ${plan.reason}`);
      const dryRun = plan.args.includes("--dry-run");
      const verifies = plan.args.includes("--verify-filters");
      expect(dryRun).toBe(mode === "estimate");
      expect(verifies).toBe(mode === "share" && verifyFilters === true);
      // Git refuses the pair, and an estimate must never run a filter.
      expect(dryRun && verifies).toBe(false);
      expect(plan.verifiedFilters).toBe(verifies);
      expect(plan.args.slice(0, 4)).toEqual(["worktree", "reflink", "--porcelain", "-z"]);
    }));
  });
});

describe("WorktreeReflinkOutputReader", () => {
  it("reads the summary of a real dry run", () => {
    const reader = new WorktreeReflinkOutputReader();
    reader.push(PWRGIT_2_DRY_RUN_PORCELAIN);
    expect(reader.finish()).toEqual({
      supported: true,
      summary: {
        scanned: 2,
        eligible: 0,
        alreadyShared: 0,
        reshared: 0,
        skipped: 2,
        failed: 0,
        observedPrivateReduction: 0,
        potentialPrivateReduction: 0,
        allocationUnknown: 0,
      },
    });
  });

  it("reports a filesystem that cannot share, which prints no summary", () => {
    const reader = new WorktreeReflinkOutputReader();
    reader.push("reflink 1\0worktree /work/wt\0dry-run 1\0backend unsupported\0\0");
    expect(reader.finish().supported).toBe(false);
  });

  it("does not take a cut-off run for a finished one", () => {
    const reader = new WorktreeReflinkOutputReader();
    reader.push(PWRGIT_2_DRY_RUN_PORCELAIN.slice(0, PWRGIT_2_DRY_RUN_PORCELAIN.indexOf("summary\0") + 20));
    expect(() => reader.finish()).toThrow(/summary/);
    expect(() => new WorktreeReflinkOutputReader().finish()).toThrow();
  });

  // Git streams one record per path. A path is any bytes but NUL, so it can
  // spell a field or a record of its own; only the summary record counts.
  const count = fc.nat({ max: 2 ** 40 });
  const totals = fc.record({
    scanned: count, eligible: count, alreadyShared: count, reshared: count, skipped: count,
    failed: count, observedPrivateReduction: count, potentialPrivateReduction: count, allocationUnknown: count,
  });
  const pathName = fc.oneof(
    fc.string({ minLength: 1 }).map((value) => value.replaceAll("\0", "") || "x"),
    fc.constantFrom("summary", "scanned 9", "a\nsummary\nscanned 7", "reflink 1", "dir/with space.txt"),
  );

  it("gives the same totals however the stream is cut into chunks", () => {
    fc.assert(fc.property(
      totals,
      fc.array(pathName, { maxLength: 6 }),
      fc.array(fc.nat(), { maxLength: 8 }),
      (summary, paths, cuts) => {
        const fields = ["reflink 1", "worktree /work/wt", "dry-run 0", "backend clone-replace", ""];
        for (const name of paths) {
          fields.push(`path ${name}`, "status skipped", "reason no-donor", "error-code 0", "scanned 123", "");
        }
        fields.push(
          "summary",
          `scanned ${summary.scanned}`, `eligible ${summary.eligible}`,
          `already-shared ${summary.alreadyShared}`, `reshared ${summary.reshared}`,
          `skipped ${summary.skipped}`, `failed ${summary.failed}`,
          "allocated-before 1", "private-before 1",
          `observed-private-reduction ${summary.observedPrivateReduction}`,
          `potential-private-reduction ${summary.potentialPrivateReduction}`,
          "deduplicated-range-bytes 5",
          `allocation-unknown ${summary.allocationUnknown}`,
          "a-field-a-later-git-adds 3",
          "",
        );
        const stream = fields.map((field) => `${field}\0`).join("");
        const offsets = [...new Set(cuts.map((cut) => cut % (stream.length + 1)))].sort((a, b) => a - b);
        const reader = new WorktreeReflinkOutputReader();
        let from = 0;
        for (const offset of [...offsets, stream.length]) {
          reader.push(stream.slice(from, offset));
          from = offset;
        }
        expect(reader.finish()).toEqual({ supported: true, summary });
      },
    ));
  });
});

// The model: a Git is selected, and the operator's window holds whatever
// capabilities it last read. The selection can change at any point between
// reading them and asking for a run. The oracle is what the Git that actually
// ran supports.
type Identity = GitRuntimeIdentity & { version: FakeGitVersion };

type Step =
  | { kind: "select"; version: FakeGitVersion }
  | { kind: "read" }
  | { kind: "run"; mode: "estimate" | "share"; verifyFilters: true | false | undefined };

const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
  fc.constantFrom(...FAKE_GIT_VERSIONS).map((version): Step => ({ kind: "select", version })),
  fc.constant<Step>({ kind: "read" }),
  fc.record({ kind: fc.constant("run" as const), mode: modeArbitrary, verifyFilters: verifyArbitrary }),
);

function harness(initial: FakeGitVersion) {
  const state = { selected: initial };
  const runs: Array<{ version: FakeGitVersion; args: string[] }> = [];
  const service = new WorktreeReflinkService<Identity>({
    probe: new WorktreeReflinkCapabilityProbe<Identity>({
      identify: async () => ({ key: state.selected, executable: `/git/${state.selected}`, version: state.selected }),
      readHelp: async (identity) => FAKE_GIT_HELP[identity.version],
    }),
    run: async (identity, _cwd, args, onStdout) => {
      runs.push({ version: identity.version, args });
      onStdout(PWRGIT_2_DRY_RUN_PORCELAIN);
    },
  });
  return { state, runs, service };
}

describe("WorktreeReflinkService", () => {
  it("never hands --verify-filters to a Git without it, or to a Git the request was not made for", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...FAKE_GIT_VERSIONS),
      fc.array(stepArbitrary, { minLength: 1, maxLength: 16 }),
      async (initial, steps) => {
        const { state, runs, service } = harness(initial);
        // The window may never have read anything: it then names no Git.
        let shown = "";
        for (const step of steps) {
          if (step.kind === "select") {
            state.selected = step.version;
            continue;
          }
          if (step.kind === "read") {
            shown = (await service.readCapabilities("/repo")).runtimeKey;
            continue;
          }
          const before = runs.length;
          const response = await service.run({
            isBusy: idle,
            cwd: "/repo",
            mode: step.mode,
            verifyFilters: step.verifyFilters,
            runtimeKey: shown,
          });
          const ran = runs.slice(before);
          expect(ran.length).toBeLessThanOrEqual(1);
          const truth = FAKE_GIT_TRUTH[state.selected];
          for (const run of ran) {
            // The Git that ran is the one selected now, and it has the command.
            expect(run.version).toBe(state.selected);
            expect(truth.reflink).toBe(true);
            const verifies = run.args.includes("--verify-filters");
            expect(run.args.includes("--dry-run")).toBe(step.mode === "estimate");
            expect(verifies).toBe(step.mode === "share" && step.verifyFilters === true);
            if (verifies) expect(truth.verifyFilters).toBe(true);
            // A share runs only for the Git the window was showing.
            if (step.mode === "share") expect(shown).toBe(state.selected);
          }
          if (response.status === "completed") {
            expect(ran).toHaveLength(1);
            expect(response.verifiedFilters).toBe(ran[0].args.includes("--verify-filters"));
            expect(response.capabilities).toEqual(truth);
          } else {
            expect(ran).toHaveLength(0);
          }
          if (response.status === "runtime-changed") {
            expect(step.mode).toBe("share");
            expect(shown).not.toBe(state.selected);
            // The answer for the Git now selected comes back with the refusal.
            expect(response.runtimeKey).toBe(state.selected);
            expect(response.capabilities).toEqual(truth);
          }
        }
      },
    ));
  });

  // The switch the option was added for, in both directions.
  it("refuses a verified share ticked under .2 once .1 is selected, and runs it once .2 is back", async () => {
    const { state, runs, service } = harness("pwrgit.2");
    const shown = await service.readCapabilities("/repo");
    expect(shown.capabilities).toEqual({ reflink: true, verifyFilters: true });

    state.selected = "pwrgit.1";
    const refused = await service.run({ isBusy: idle, cwd: "/repo", mode: "share", verifyFilters: true, runtimeKey: shown.runtimeKey });
    expect(refused).toMatchObject({
      status: "runtime-changed",
      capabilities: { reflink: true, verifyFilters: false },
    });
    expect(runs).toHaveLength(0);

    // Even when the window claims the .1 runtime, .1 is never asked to verify.
    const forced = await service.run({ isBusy: idle, cwd: "/repo", mode: "share", verifyFilters: true, runtimeKey: "pwrgit.1" });
    expect(forced.status).toBe("failed");
    expect(runs).toHaveLength(0);

    state.selected = "pwrgit.2";
    const ran = await service.run({ isBusy: idle, cwd: "/repo", mode: "share", verifyFilters: true, runtimeKey: shown.runtimeKey });
    expect(ran).toMatchObject({ status: "completed", verifiedFilters: true });
    expect(runs).toEqual([
      { version: "pwrgit.2", args: ["worktree", "reflink", "--porcelain", "-z", "--verify-filters"] },
    ]);
  });

  it("keeps the summary Git printed before it exited non-zero, and reports Git's own complaint otherwise", async () => {
    const identity: Identity = { key: "k", executable: "/git", version: "pwrgit.2" };
    const failing = (stdout: string, error: object) => new WorktreeReflinkService<Identity>({
      probe: { read: async () => ({ identity, capabilities: FAKE_GIT_TRUTH["pwrgit.2"], answered: true }) },
      run: async (_identity, _cwd, _args, onStdout) => {
        onStdout(stdout);
        throw Object.assign(new Error("Git exited with code 1."), error);
      },
    });
    await expect(failing(PWRGIT_2_DRY_RUN_PORCELAIN, { exitCode: 1, stderr: "" })
      .run({ isBusy: idle, cwd: "/repo", mode: "share", runtimeKey: "k" }))
      .resolves.toMatchObject({ status: "completed", summary: { scanned: 2, skipped: 2 } });
    await expect(failing("", { exitCode: 128, stderr: "fatal: reflink requires an existing non-bare worktree\n" })
      .run({ isBusy: idle, cwd: "/repo", mode: "share", runtimeKey: "k" }))
      .resolves.toEqual({ status: "failed", reason: "reflink requires an existing non-bare worktree" });
  });

  it("runs one share at a time for a worktree", async () => {
    const identity: Identity = { key: "k", executable: "/git", version: "pwrgit.2" };
    let release: (() => void) | undefined;
    const service = new WorktreeReflinkService<Identity>({
      probe: { read: async () => ({ identity, capabilities: FAKE_GIT_TRUTH["pwrgit.2"], answered: true }) },
      run: async (_identity, _cwd, _args, onStdout) => {
        await new Promise<void>((resolve) => { release = resolve; });
        onStdout(PWRGIT_2_DRY_RUN_PORCELAIN);
      },
    });
    const first = service.run({ isBusy: idle, cwd: "/repo", mode: "share", runtimeKey: "k" });
    await expect.poll(() => release).toBeDefined();
    await expect(service.run({ isBusy: idle, cwd: "/repo", mode: "share", runtimeKey: "k" }))
      .resolves.toMatchObject({ status: "failed" });
    release!();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    release = undefined;
    const again = service.run({ isBusy: idle, cwd: "/repo", mode: "share", runtimeKey: "k" });
    await expect.poll(() => release).toBeDefined();
    release!();
    await expect(again).resolves.toMatchObject({ status: "completed" });
  });

  // A share replaces files. A turn in the worktree, in any thread, is writing
  // them. The model: the worktree is busy or not at each request, and the
  // oracle is that Git is launched for a share only when it was not.
  it("never starts a share while a turn runs in the worktree, and never lets a turn stop an estimate", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ mode: modeArbitrary, busy: fc.boolean() }), { minLength: 1, maxLength: 20 }),
      async (requests) => {
        const { runs, service } = harness("pwrgit.2");
        const runtimeKey = (await service.readCapabilities("/repo")).runtimeKey;
        for (const request of requests) {
          const before = runs.length;
          const response = await service.run({
            cwd: "/repo",
            mode: request.mode,
            runtimeKey,
            isBusy: async () => request.busy,
          });
          if (request.mode === "share" && request.busy) {
            expect(response).toEqual({ status: "failed", reason: WORKTREE_TURN_RUNNING_REASON });
            expect(runs).toHaveLength(before);
          } else {
            // A refused share leaves nothing claimed: the next request runs.
            expect(response.status).toBe("completed");
            expect(runs).toHaveLength(before + 1);
            expect(runs[before].args.includes("--dry-run")).toBe(request.mode === "estimate");
          }
        }
      },
    ));
  });

  it("does not ask whether the worktree is busy for a share Git would not run", async () => {
    const { state, service } = harness("pwrgit.2");
    const runtimeKey = (await service.readCapabilities("/repo")).runtimeKey;
    state.selected = "pwrgit.1";
    let asked = 0;
    const isBusy = async () => { asked += 1; return true; };
    await expect(service.run({ cwd: "/repo", mode: "share", runtimeKey, isBusy }))
      .resolves.toMatchObject({ status: "runtime-changed" });
    expect(asked).toBe(0);
  });

  it("does not share when it cannot learn whether the worktree is busy, and still estimates", async () => {
    const { runs, service } = harness("pwrgit.2");
    const runtimeKey = (await service.readCapabilities("/repo")).runtimeKey;
    const isBusy = async (): Promise<boolean> => { throw new Error("backend unavailable"); };
    await expect(service.run({ cwd: "/repo", mode: "share", runtimeKey, isBusy }))
      .resolves.toEqual({ status: "failed", reason: WORKTREE_BUSY_UNKNOWN_REASON });
    expect(runs).toHaveLength(0);
    await expect(service.run({ cwd: "/repo", mode: "estimate", runtimeKey, isBusy }))
      .resolves.toMatchObject({ status: "completed" });
  });

  it("names the Git, not the worktree, when the selected Git cannot be resolved", async () => {
    const service = new WorktreeReflinkService<Identity>({
      probe: new WorktreeReflinkCapabilityProbe<Identity>({
        identify: async () => ({ key: "k", version: "pwrgit.2" }),
        readHelp: async () => { throw new Error("must not run"); },
      }),
      run: async () => { throw new Error("must not run"); },
    });
    await expect(service.run({ isBusy: idle, cwd: "/repo", mode: "estimate", runtimeKey: "k" }))
      .resolves.toEqual({ status: "failed", reason: "The selected Git is unavailable." });
  });

  it("says Git could not be run, rather than that it cannot share, when the worktree gives no usage", async () => {
    const service = new WorktreeReflinkService<Identity>({
      probe: new WorktreeReflinkCapabilityProbe<Identity>({
        identify: async () => ({ key: "k", executable: "/git", version: "pwrgit.2" }),
        readHelp: async () => "fatal: not a git repository (or any of the parent directories): .git\n",
      }),
      run: async () => { throw new Error("must not run"); },
    });
    await expect(service.run({ isBusy: idle, cwd: "/gone", mode: "estimate", runtimeKey: "k" }))
      .resolves.toEqual({ status: "failed", reason: "The selected Git could not be run in this worktree." });
  });
});
