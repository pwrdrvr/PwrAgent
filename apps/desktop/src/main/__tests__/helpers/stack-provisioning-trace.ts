import { ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { vi } from "vitest";
import { GhStackCatalogStore, type RuntimeJournal } from "../../stacks/stack-engine-ports";

type ProcessLaunch = { file?: string; args?: string[] };
type TracedChild = ChildProcess & { spawn(options: ProcessLaunch): void };

function gitCommandLabel(args: string[]): string | undefined {
  let index = 1; // Node includes the executable as argv[0].
  while (args[index]?.startsWith("-")) {
    const option = args[index++];
    if (["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--super-prefix"].includes(option)) index++;
  }
  const verb = args[index];
  const subcommand = args[index + 1];
  if (verb === "worktree" && ["add", "list", "lock", "prune", "remove", "repair", "unlock"].includes(subcommand)) return "worktree " + subcommand;
  if (verb === "stash" && subcommand === "create") return "stash create";
  return verb;
}

/** Record this fixture's Git and lock/replace children without argv or output. */
export function traceStackProvisioning(root: string, commonDir: string, fault: string) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const stages: object[] = [];
  const processes: object[] = [];
  let phase = "apply";
  const record = (event: string, detail: object = {}) => stages.push({ ms: elapsed(), phase, event, ...detail });
  const pathKey = (value: string) => {
    const normalized = value.replaceAll("\\", "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const fixturePrefix = pathKey(root) + "/";
  const prototype = ChildProcess.prototype as TracedChild;
  const spawn = prototype.spawn;
  const spawnSpy = vi.spyOn(prototype, "spawn").mockImplementation(function (this: TracedChild, options) {
    const file = basename(options.file ?? "");
    const args = options.args ?? [];
    if (!args.some((arg) => pathKey(arg) === pathKey(root) || pathKey(arg).startsWith(fixturePrefix))) return spawn.call(this, options);
    const git = /^git(?:\.exe)?$/i.test(file);
    const command = git ? gitCommandLabel(args) : args.find((arg) => arg.startsWith("--stack-"));
    if (!command) return spawn.call(this, options);
    const observation = {
      phase, file, command,
      requestedMs: elapsed(), pid: undefined as number | undefined,
      spawnedMs: undefined as number | undefined, exitedMs: undefined as number | undefined,
      closedMs: undefined as number | undefined, exitCode: undefined as number | null | undefined,
      exitSignal: undefined as NodeJS.Signals | null | undefined, errorCode: undefined as string | undefined,
    };
    processes.push(observation);
    this.once("spawn", () => { observation.spawnedMs = elapsed(); observation.pid = this.pid; });
    this.once("exit", (code, signal) => {
      observation.exitedMs = elapsed();
      observation.exitCode = code;
      observation.exitSignal = signal;
    });
    this.once("close", () => { observation.closedMs = elapsed(); });
    this.once("error", (error: NodeJS.ErrnoException) => { observation.errorCode = error.code; });
    return spawn.call(this, options);
  });

  const catalog = GhStackCatalogStore.prototype;
  const initialStage = (notice: RuntimeJournal["notification"] | undefined) =>
    notice?.kind === "add_branch" && notice.options?.newThread ? "pending" : undefined;
  const journalHooks = catalog.journalHooks;
  const hooksSpy = vi.spyOn(catalog, "journalHooks").mockImplementation(function (this: GhStackCatalogStore, dir, notice) {
    const hooks = journalHooks.call(this, dir, notice);
    if (pathKey(dir) !== pathKey(commonDir)) return hooks;
    return { ...hooks, begin: async (entry) => {
      await hooks.begin?.(entry);
      record("journal-written", { committed: false, stage: initialStage(notice) });
    } };
  });
  const markCommitted = catalog.markJournalCommitted;
  const commitSpy = vi.spyOn(catalog, "markJournalCommitted").mockImplementation(async function (this: GhStackCatalogStore, ...args) {
    await markCommitted.call(this, ...args);
    const [dir, entry, notice] = args;
    if (pathKey(dir) === pathKey(commonDir)) {
      const stage = "provisioning" in entry ? (entry as RuntimeJournal).provisioning?.stage : initialStage(notice);
      record("journal-written", { committed: true, stage });
    }
  });
  const writeProvisioning = catalog.writeProvisioning;
  const checkpointSpy = vi.spyOn(catalog, "writeProvisioning").mockImplementation(async function (this: GhStackCatalogStore, ...args) {
    await writeProvisioning.call(this, ...args);
    if (pathKey(args[0]) === pathKey(commonDir)) record("journal-written", { committed: args[1].committed === true, stage: args[2].stage });
  });

  return {
    record,
    phase(next: string) { phase = next; record("entered"); },
    finish(failed: boolean) {
      spawnSpy.mockRestore();
      hooksSpy.mockRestore();
      commitSpy.mockRestore();
      checkpointSpy.mockRestore();
      if (failed) record("test-failed");
      if (failed || process.env.PWRAGENT_STACK_PROVISION_TRACE === "1") {
        console.error("stack-provisioning-trace", JSON.stringify({ fault, platform: process.platform, stages, processes }));
      }
    },
  };
}
