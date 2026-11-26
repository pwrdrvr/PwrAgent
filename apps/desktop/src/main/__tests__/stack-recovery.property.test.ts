import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { StackEngine } from "@pwragent/owner-core/stacks/engine/index";
import { expect, inject, it, onTestFinished, vi } from "vitest";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { runGitCommand } from "../app-server/git-executable";
import { bundledGitDirectory, bundledGitExecutable, configureBundledGit } from "../bundled-git";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { GhStackCatalogStore, STACK_OPERATION_JOURNAL, stackGitRunner } from "../stacks/stack-engine-ports";
import { StackOperationsService } from "../stacks/stack-operations-service";
import { isolateProcessGitEnvironment, runIsolatedGit } from "./helpers/isolated-git";

vi.mock("../native-relay-path", () => ({ nativeRelayPath: () => inject("nativeHelperFixtures").stackEngine!.relay }));

const registry = {
  withStackWorktreeMutation: async <T>(_commonDir: string, run: () => Promise<T>) => await run(),
} as DesktopBackendRegistry;

async function sandboxWithPackagedGit() {
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "pwragent-stack-recovery-oracle-")));
  onTestFinished(async () => await rm(sandbox, { recursive: true, force: true }));
  onTestFinished(isolateProcessGitEnvironment(sandbox));
  // Exercise the packaged discovery path even when the runner has loader
  // overrides or Git test flags in its environment.
  onTestFinished(() => { vi.unstubAllEnvs(); });
  for (const key of Object.keys(process.env)) {
    if (/^(?:DYLD_|LD_|GIT_TEST_)/.test(key) || /^GIT_IMPLICIT_WORK_TREE$/i.test(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  configureBundledGit(path.dirname(bundledGitDirectory()));
  onTestFinished(() => configureBundledGit(undefined));
  process.env.PWRAGENT_GIT_PATH = bundledGitExecutable();
  return sandbox;
}

async function init(cwd: string) {
  await mkdir(cwd);
  await runIsolatedGit(cwd, ["init", "-b", "main"]);
  await runIsolatedGit(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture base"]);
  await runIsolatedGit(cwd, ["branch", "fixture-layer"]);
}

async function writeInterruptedAdoption(store: GhStackCatalogStore, commonDir: string) {
  const cwd = path.dirname(commonDir);
  const { stdout } = await runIsolatedGit(cwd, ["rev-parse", "HEAD"]);
  const head = stdout.trim();
  const engine = new StackEngine(stackGitRunner, store, cwd, commonDir);
  const plan = await engine.plan({ kind: "adopt", repository: "github.com:fixture/stack", stack: {
    trunk: { branch: "main", head },
    branches: [{ branch: "fixture-layer", base: head, head }],
  } });
  const notice = { opId: "fixture-adopt", actor: { backend: "codex" as const, threadId: "lead" }, kind: "adopt" as const, participants: [] };
  const hooks = store.journalHooks(commonDir, notice);
  const interrupted = new Error("Stopped after durable journal publication before the ref transaction");
  await expect(engine.apply(plan, notice.opId, 1, {
    begin: async (entry) => {
      await hooks.begin?.(entry);
      throw interrupted;
    },
  })).rejects.toBe(interrupted);
}

it.skipIf(process.platform === "win32")("re-probes journal candidates while pruning ordinary empty paths for explicitly selected bundled Git", async () => {
  const sandbox = await sandboxWithPackagedGit();
  const repos = [path.join(sandbox, "first"), path.join(sandbox, "second")];
  const topic = path.join(sandbox, "topic");
  const moved = path.join(sandbox, "moved");
  const alias = path.join(sandbox, "alias");
  const subdirectory = path.join(repos[1]!, "nested");
  for (const repo of repos) await init(repo);
  await runIsolatedGit(repos[0]!, ["worktree", "add", "-b", "topic", topic]);
  await runIsolatedGit(repos[0]!, ["worktree", "move", topic, moved]);
  await symlink(moved, alias, "dir");
  await mkdir(subdirectory);
  const directories = [repos[0]!, subdirectory, alias, moved, topic];
  const commons = await Promise.all(directories.map(async (cwd) => {
    const result = await runGitCommand(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => undefined);
    return result && await realpath(result.stdout.trim());
  }));
  expect(commons).toEqual([path.join(repos[0]!, ".git"), path.join(repos[1]!, ".git"),
    path.join(repos[0]!, ".git"), path.join(repos[0]!, ".git"), undefined]);
  const store = new GhStackCatalogStore();
  const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
  onTestFinished(() => start.mockRestore());
  await fc.assert(fc.asyncProperty(
    fc.shuffledSubarray(directories, { minLength: 2 }), fc.tuple(fc.boolean(), fc.boolean()), fc.boolean(),
    async (inputs, pending, concurrent) => {
      const journals = new Set(repos.flatMap((repo, index) => pending[index] ? [path.join(repo, ".git")] : []));
      for (const commonDir of journals) await writeInterruptedAdoption(store, commonDir);
      try {
        const reachable = new Set(inputs.map((cwd) => commons[directories.indexOf(cwd)]));
        start.mockClear();
        const recover = () => new StackOperationsService().resumeInterrupted(inputs, registry);
        expect((await Promise.all(concurrent ? [recover(), recover()] : [recover()])).flat()).toEqual([]);
        for (const commonDir of journals) {
          expect(await store.hasJournal(commonDir)).toBe(!reachable.has(commonDir));
          await expect(readFile(path.join(commonDir, "gh-stack"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }
        const checked = start.mock.calls.filter(([, [verb], purpose]) => verb === "rev-parse" && purpose === "stack-checkout")
          .map(([cwd]) => cwd);
        const empty = inputs.filter((cwd) => {
          const commonDir = commons[directories.indexOf(cwd)];
          return commonDir && !journals.has(commonDir);
        });
        expect(checked.filter((cwd) => empty.includes(cwd))).toEqual([]);
      } finally {
        await Promise.all([...journals].map((commonDir) => rm(path.join(commonDir, STACK_OPERATION_JOURNAL), { force: true })));
      }
    },
  ), {
    numRuns: 12,
    examples: [
      [[repos[0]!, subdirectory], [false, false], false],
      [[alias, topic], [true, false], true],
      [[subdirectory, topic], [true, false], false],
    ],
  });
});

it.skipIf(process.platform === "win32").each(["wrapper", "common-dir override"] as const)(
  "recovers an off-roster journal selected by a %s",
  async (mode) => {
    const sandbox = await sandboxWithPackagedGit();
    const hidden = path.join(sandbox, "hidden");
    const listed = path.join(sandbox, "listed");
    await init(hidden);
    const commonDir = path.join(hidden, ".git");
    const store = new GhStackCatalogStore();
    await writeInterruptedAdoption(store, commonDir);
    if (mode === "wrapper") {
      // A custom Git can recover even when the linked path itself is gone.
      const wrapper = path.join(sandbox, "wrapper");
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      await writeFile(wrapper, [
        "#!/bin/sh",
        `if [ "$1" = "-C" ] && [ "$2" = ${quote(listed)} ]; then shift 2; set -- -C ${quote(hidden)} "$@"; fi`,
        `exec ${quote(bundledGitExecutable())} "$@"`,
        "",
      ].join("\n"), { mode: 0o700 });
      process.env.PWRAGENT_GIT_PATH = wrapper;
    } else {
      await init(listed);
      process.env.GIT_COMMON_DIR = commonDir;
    }
    expect(await new StackOperationsService().resumeInterrupted([listed], registry)).toEqual([]);
    expect(await store.hasJournal(commonDir)).toBe(false);
  },
);
