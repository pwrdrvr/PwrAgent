import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  NO_WORKTREE_REFLINK_CAPABILITIES,
  WorktreeReflinkCapabilityProbe,
  parseWorktreeReflinkHelp,
  type GitRuntimeIdentity,
} from "../git-worktree-reflink-capabilities";
import {
  FAKE_GIT_HELP,
  FAKE_GIT_TRUTH,
  FAKE_GIT_VERSIONS,
  PWRGIT_1_HELP,
  PWRGIT_1_UNKNOWN_OPTION,
  PWRGIT_2_HELP,
  STOCK_GIT_HELP,
  type FakeGitVersion,
} from "./worktree-reflink-fixtures";

describe("parseWorktreeReflinkHelp", () => {
  it("reads the published releases' own help", () => {
    expect(parseWorktreeReflinkHelp(PWRGIT_1_HELP)).toEqual({ reflink: true, verifyFilters: false });
    expect(parseWorktreeReflinkHelp(PWRGIT_2_HELP)).toEqual({ reflink: true, verifyFilters: true });
    expect(parseWorktreeReflinkHelp(STOCK_GIT_HELP)).toEqual(NO_WORKTREE_REFLINK_CAPABILITIES);
  });

  it("does not take an option named by an error for an option the command has", () => {
    expect(parseWorktreeReflinkHelp(PWRGIT_1_UNKNOWN_OPTION)).toEqual(NO_WORKTREE_REFLINK_CAPABILITIES);
    expect(parseWorktreeReflinkHelp(`${PWRGIT_1_UNKNOWN_OPTION}\n${PWRGIT_1_HELP}`))
      .toEqual({ reflink: true, verifyFilters: false });
  });

  // The rule: an option is supported exactly when the help of `git worktree
  // reflink` has a row for it. Every other place the name can appear is a
  // decoy: the synopsis (where .2 really prints it), a description, an error,
  // a longer option that starts or ends with the same letters.
  const OPTIONS = [
    { name: "dry-run", short: "n", description: "report estimates without sharing data" },
    { name: "verify-filters", description: "run clean filters to verify stat-ambiguous matching files" },
    { name: "porcelain", description: "machine-readable output" },
    { name: "verbose", short: "v", description: "report each path and reason" },
    { name: "reflink-source", argument: "<worktree>", description: "worktree holding matching physical bytes" },
    { name: "verify-filters-strict", description: "a longer option" },
    { name: "reverify-filters", description: "another option" },
    { name: "verify-filter", description: "a shorter option" },
  ] as const;

  const helpArbitrary = fc.record({
    reflinkUsage: fc.boolean(),
    synopsisNamesVerifyFilters: fc.boolean(),
    errorNamesVerifyFilters: fc.boolean(),
    descriptionNamesVerifyFilters: fc.boolean(),
    rows: fc.subarray([...OPTIONS], { minLength: 0 }),
    negatable: fc.boolean(),
    indent: fc.constantFrom("    ", "  ", "\t"),
    eol: fc.constantFrom("\n", "\r\n"),
  });

  function renderHelp(input: typeof helpArbitrary extends fc.Arbitrary<infer T> ? T : never): string {
    const lines: string[] = [];
    if (input.errorNamesVerifyFilters) lines.push("error: unknown option `verify-filters'");
    lines.push(input.reflinkUsage
      ? `usage: git worktree reflink [-n${input.synopsisNamesVerifyFilters ? " | --verify-filters" : ""}] [-v | --porcelain [-z]]`
      : "usage: git worktree add [-f] [--detach] <path> [<commit-ish>]");
    lines.push(input.synopsisNamesVerifyFilters
      ? "                        [--verify-filters] [--dry-run] [--porcelain] [<worktree>]"
      : "                        [--reflink-source=<worktree>] [<worktree>]");
    if (!input.reflinkUsage) lines.push("   or: git worktree list [-v | --porcelain [-z]]");
    lines.push("");
    for (const option of input.rows) {
      const long = `--${input.negatable ? "[no-]" : ""}${option.name}`;
      const head = `${input.indent}${"short" in option ? `-${option.short}, ` : ""}${long}`;
      const description = input.descriptionNamesVerifyFilters
        ? `${option.description}; see --verify-filters and --dry-run --porcelain`
        : option.description;
      if ("argument" in option) {
        lines.push(`${head} ${option.argument}`, `                          ${description}`);
      } else {
        lines.push(`${head} ${description}`);
      }
    }
    lines.push("");
    return lines.join(input.eol);
  }

  it("offers an option only when the reflink help has a row for it", () => {
    fc.assert(fc.property(helpArbitrary, (input) => {
      const has = (name: string) => input.rows.some((option) => option.name === name);
      const reflink = input.reflinkUsage && has("dry-run") && has("porcelain");
      expect(parseWorktreeReflinkHelp(renderHelp(input))).toEqual({
        reflink,
        verifyFilters: reflink && has("verify-filters"),
      });
    }));
  });
});

// The model: Git binaries at paths, one of them selected. A binary can be
// replaced in place (a release installed over the old one), which gives it a
// new stamp. The oracle is the table of what each release supports.
type Identity = GitRuntimeIdentity & { path: string };

type Operation =
  | { kind: "read" }
  | { kind: "select"; path: string }
  | { kind: "replace"; path: string; version: FakeGitVersion }
  | { kind: "invalidate" };

const PATHS = ["/git/a", "/git/b", "/git/c"];

function world() {
  let stamp = 0;
  const versionByKey = new Map<string, FakeGitVersion>();
  const binaries = new Map<string, { version: FakeGitVersion; stamp: number }>();
  const install = (path: string, version: FakeGitVersion): void => {
    stamp += 1;
    binaries.set(path, { version, stamp });
    versionByKey.set(`${path}@${stamp}`, version);
  };
  install("/git/a", "pwrgit.1");
  install("/git/b", "pwrgit.2");
  install("/git/c", "stock");
  const state = { selected: "/git/a", helpReads: 0 };
  return {
    state,
    install,
    truth: (key: string) => FAKE_GIT_TRUTH[versionByKey.get(key)!],
    currentKey: () => `${state.selected}@${binaries.get(state.selected)!.stamp}`,
    identify: (): Identity => ({
      key: `${state.selected}@${binaries.get(state.selected)!.stamp}`,
      executable: state.selected,
      path: state.selected,
    }),
    help: (identity: Identity): string => {
      state.helpReads += 1;
      return FAKE_GIT_HELP[binaries.get(identity.path)!.version];
    },
  };
}

const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Operation>({ kind: "read" }) },
  { weight: 3, arbitrary: fc.constantFrom(...PATHS).map((path): Operation => ({ kind: "select", path })) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("replace" as const),
      path: fc.constantFrom(...PATHS),
      version: fc.constantFrom(...FAKE_GIT_VERSIONS),
    }),
  },
  { weight: 1, arbitrary: fc.constant<Operation>({ kind: "invalidate" }) },
);

/**
 * Release every scheduled step, including the ones a released step goes on
 * to schedule. A probe schedules its next step a few microtasks later.
 */
async function drain(scheduler: fc.Scheduler): Promise<void> {
  for (;;) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    if (scheduler.count() === 0) return;
    await scheduler.waitOne();
  }
}

describe("WorktreeReflinkCapabilityProbe", () => {
  it("never reports one Git's capabilities for another, however probes and switches interleave", async () => {
    await fc.assert(fc.asyncProperty(
      fc.scheduler(),
      fc.array(operationArbitrary, { minLength: 1, maxLength: 12 }),
      async (scheduler, operations) => {
        const git = world();
        // Each call lands at a moment the scheduler picks, so a selection or
        // an install can fall between any two steps of a probe.
        const identify = scheduler.scheduleFunction(async () => git.identify());
        const readHelp = scheduler.scheduleFunction(async (identity: Identity) => git.help(identity));
        const probe = new WorktreeReflinkCapabilityProbe<Identity>({
          identify: () => identify(),
          readHelp: (identity) => readHelp(identity),
        });
        const results: Array<{ identity: Identity; capabilities: unknown }> = [];
        const reads: Array<Promise<unknown>> = [];
        for (const operation of operations) {
          void scheduler.schedule(Promise.resolve(operation)).then(() => {
            if (operation.kind === "read") {
              reads.push(probe.read("/repo").then((result) => results.push(result)));
            } else if (operation.kind === "select") git.state.selected = operation.path;
            else if (operation.kind === "replace") git.install(operation.path, operation.version);
            else probe.invalidate();
          });
        }
        await drain(scheduler);
        await Promise.all(reads);

        for (const result of results) {
          // A probe that could not settle answers "nothing", which is safe
          // for any Git. Anything it does claim must be true of the Git it names.
          if (result.capabilities === NO_WORKTREE_REFLINK_CAPABILITIES) continue;
          expect(result.capabilities).toEqual(git.truth(result.identity.key));
        }
        // Once nothing is changing, the answer is the selected Git's, exactly.
        const settling = probe.read("/repo");
        await drain(scheduler);
        const settled = await settling;
        expect(settled.identity.key).toBe(git.currentKey());
        expect(settled.capabilities).toEqual(git.truth(git.currentKey()));
      },
    ));
  });

  // The two orders the model above is built to catch, by name.
  it.each([
    { from: "/git/a", to: "/git/b", expected: { reflink: true, verifyFilters: true } },
    { from: "/git/b", to: "/git/a", expected: { reflink: true, verifyFilters: false } },
  ])("discards a probe of $from that finishes after $to was selected", async ({ from, to, expected }) => {
    const git = world();
    git.state.selected = from;
    let releaseStaleHelp: (() => void) | undefined;
    const probe = new WorktreeReflinkCapabilityProbe<Identity>({
      identify: async () => git.identify(),
      readHelp: async (identity) => {
        const help = git.help(identity);
        if (identity.path === from) await new Promise<void>((resolve) => { releaseStaleHelp = resolve; });
        return help;
      },
    });
    const reading = probe.read("/repo");
    await vi.waitFor(() => expect(releaseStaleHelp).toBeDefined());
    git.state.selected = to;
    releaseStaleHelp!();
    const result = await reading;
    expect(result.identity.path).toBe(to);
    expect(result.capabilities).toEqual(expected);
    // And the late answer was not kept for either Git.
    expect((await probe.read("/repo")).capabilities).toEqual(expected);
    git.state.selected = from;
    releaseStaleHelp = () => undefined;
    const back = probe.read("/repo");
    await vi.waitFor(() => expect(git.state.helpReads).toBe(3));
    releaseStaleHelp();
    expect((await back).capabilities).toEqual(git.truth(git.currentKey()));
  });

  it("probes a Git once, and again when a new binary takes its path", async () => {
    const git = world();
    const probe = new WorktreeReflinkCapabilityProbe<Identity>({
      identify: async () => git.identify(),
      readHelp: async (identity) => git.help(identity),
    });
    expect((await probe.read("/repo")).capabilities).toEqual({ reflink: true, verifyFilters: false });
    await probe.read("/repo");
    expect(git.state.helpReads).toBe(1);
    // A remembered answer is paired with the identity read now, which is what
    // carries the environment the next run uses.
    const fresh = { ...git.identify(), env: "now" };
    const remembering = new WorktreeReflinkCapabilityProbe<Identity & { env?: string }>({
      identify: async () => fresh,
      readHelp: async (identity) => git.help(identity),
    });
    const first = await remembering.read("/repo");
    fresh.env = "later";
    const second = await remembering.read("/repo");
    expect(second.identity.env).toBe("later");
    expect(second.capabilities).toEqual(first.capabilities);
    expect(git.state.helpReads).toBe(2);
    git.state.helpReads = 1;
    git.install("/git/a", "pwrgit.2");
    expect((await probe.read("/repo")).capabilities).toEqual({ reflink: true, verifyFilters: true });
    expect(git.state.helpReads).toBe(2);
  });

  it.each([
    { failure: "Git never ran", help: undefined },
    { failure: "the directory is not a repository", help: "fatal: not a git repository (or any of the parent directories): .git\n" },
    { failure: "the directory is gone", help: "fatal: cannot change to '/repo': No such file or directory\n" },
  ])("offers nothing, and remembers nothing, when $failure", async ({ help }) => {
    const git = world();
    git.state.selected = "/git/b";
    let failing = true;
    const probe = new WorktreeReflinkCapabilityProbe<Identity>({
      identify: async () => git.identify(),
      readHelp: async (identity) => {
        if (!failing) return git.help(identity);
        if (help === undefined) throw new Error("spawn ENOENT");
        return help;
      },
    });
    expect((await probe.read("/repo")).capabilities).toEqual(NO_WORKTREE_REFLINK_CAPABILITIES);
    failing = false;
    expect((await probe.read("/repo")).capabilities).toEqual({ reflink: true, verifyFilters: true });
  });

  it("remembers that a Git without the subcommand has nothing to offer", async () => {
    const git = world();
    git.state.selected = "/git/c";
    const probe = new WorktreeReflinkCapabilityProbe<Identity>({
      identify: async () => git.identify(),
      readHelp: async (identity) => git.help(identity),
    });
    expect((await probe.read("/repo")).capabilities).toEqual(NO_WORKTREE_REFLINK_CAPABILITIES);
    await probe.read("/repo");
    expect(git.state.helpReads).toBe(1);
  });
});
