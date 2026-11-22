import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerNotification,
  CodexThreadEnvironmentRuntime,
} from "@pwragent/shared/contracts/normalized-app-server";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { CodexEnvironmentStartupError } from "../app-server/codex-environment-runtime";
import type { ThreadDirectoryService } from "../app-server/thread-directory-service";
import { createOverlayStoreMock, MockBackendClient } from "./helpers/backend-registry-fixture";

/**
 * The rule a starting row rests on: a start that prepares a workspace is in
 * the lists from before its worktree or setup begins until its thread has
 * one, and never longer.
 *
 * For every start that asks for a row, whatever the other starts running
 * beside it do, and however each one ends:
 *
 * - `starting` is reported before the worktree is prepared.
 * - `landed` is reported once, only when the provider created the thread,
 *   with that thread's id, and before this owner says anything else about
 *   the thread (here its `thread/parent/set`).
 * - `ended` is reported exactly once, last, after a refused start has rolled
 *   its worktree back, and names the thread when one landed.
 * - A failed environment setup still lands the thread and reports the
 *   failure on it.
 *
 * Before this rule, a to-do card's start reported nothing until the thread
 * existed: the list had no row for the whole of worktree and setup.
 */

type PendingReport = Extract<AppServerNotification, { method: "thread/start/pending" }>["params"];

type Outcome = {
  worktree: "ok" | "refused";
  setup: "none" | "ok" | "failed";
  provider: "ok" | "refused";
  parent: boolean;
};

type LogEntry =
  | { kind: "effect"; start: number; effect: "prepare" | "prepared" | "setup" | "set-up" | "provider" | "provided" | "rollback" }
  | { kind: "pending"; start: number; phase: string; createdThreadId?: string; setupFailure?: string }
  | { kind: "snapshot"; start: number; phase: string; starts: string[] }
  | { kind: "progress"; start: number; output: string | undefined }
  | { kind: "parent-set"; threadId: string }
  | { kind: "settled"; start: number; ok: boolean; setupFailure: boolean };

const outcomeArbitrary: fc.Arbitrary<Outcome> = fc.record({
  worktree: fc.constantFrom("ok", "refused"),
  setup: fc.constantFrom("none", "ok", "failed"),
  provider: fc.constantFrom("ok", "refused"),
  parent: fc.boolean(),
});

const sourceRuntime: CodexThreadEnvironmentRuntime = {
  environmentId: "environment",
  environmentName: "Repo Environment",
  executionTarget: "local",
  cwd: "/repo",
  setupCommand: "echo setup",
};

const startIndexOf = (path: string | undefined): number => Number(/(\d+)$/.exec(path ?? "")?.[1] ?? -1);

async function runStarts(scheduler: fc.Scheduler, outcomes: readonly Outcome[]): Promise<LogEntry[]> {
  const log: LogEntry[] = [];
  const step = async (): Promise<void> => { await scheduler.schedule(Promise.resolve()); };
  const codexClient = new MockBackendClient({ threads: [] });
  vi.spyOn(codexClient, "startThread").mockImplementation(async (params) => {
    const start = startIndexOf(params?.cwd);
    log.push({ kind: "effect", start, effect: "provider" });
    await step();
    if (outcomes[start]!.provider === "refused") throw new Error("thread/start refused");
    log.push({ kind: "effect", start, effect: "provided" });
    return { threadId: `thread-${start}` };
  });
  const registry = createDesktopBackendRegistry({
    codexClient,
    overlayStore: createOverlayStoreMock(),
    gitDirectoryService: {
      prepareLaunchpadWorkspace: async (launchpad: { directoryPath: string }) => {
        const start = startIndexOf(launchpad.directoryPath);
        log.push({ kind: "effect", start, effect: "prepare" });
        await step();
        if (outcomes[start]!.worktree === "refused") throw new Error("worktree refused");
        log.push({ kind: "effect", start, effect: "prepared" });
        return {
          cwd: `/worktrees/${start}`,
          workMode: "worktree" as const,
          repositoryPath: `/repo/project-${start}`,
          rollback: async () => { log.push({ kind: "effect", start, effect: "rollback" }); },
        };
      },
    } as never,
  });
  const directoryService = (registry as unknown as { threadDirectoryService: ThreadDirectoryService }).threadDirectoryService;
  vi.spyOn(directoryService, "buildForkedCodexEnvironmentRuntime").mockImplementation(async (params) => {
    const start = startIndexOf(params.cwd);
    log.push({ kind: "effect", start, effect: "setup" });
    params.onSetupProgress?.({
      at: 1, environmentId: "environment", environmentName: "Repo Environment",
      command: "echo setup", phase: "stdout", chunk: `setup for ${start}`,
    });
    await step();
    const runtime = { ...sourceRuntime, cwd: params.cwd };
    if (outcomes[start]!.setup === "failed") {
      throw new CodexEnvironmentStartupError("echo setup exited 1", "setup", { ...runtime, setupStatus: "failed" });
    }
    log.push({ kind: "effect", start, effect: "set-up" });
    return { ...runtime, setupStatus: "completed" };
  });
  registry.onEvent((event: AgentEvent) => {
    const notification = event.notification as AppServerNotification;
    if (notification.method === "thread/start/pending") {
      const { start, phase, createdThreadId, setupProgress, setupFailure } = notification.params as PendingReport;
      const index = Number(start.startId.replace("card-", ""));
      if (setupProgress && phase === "setup") {
        log.push({ kind: "progress", start: index, output: setupProgress.output });
      }
      log.push({ kind: "pending", start: Number(start.startId.replace("card-", "")), phase,
        ...(createdThreadId ? { createdThreadId } : {}), ...(setupFailure ? { setupFailure: setupFailure.message } : {}) });
      const snapshot = registry.listPendingThreadStarts?.();
      log.push({ kind: "snapshot", start: index, phase, starts: snapshot?.map((entry) => entry.start.startId) ?? [] });
    } else if (notification.method === "thread/parent/set") {
      log.push({ kind: "parent-set", threadId: (notification.params as { threadId: string }).threadId });
    }
  });
  const runs = outcomes.map((outcome, start) => registry.startThread({
    backend: "codex",
    cwd: `/repo/project-${start}`,
    workMode: "worktree",
    ...(outcome.setup === "none" ? {} : { codexEnvironmentRuntime: sourceRuntime }),
    ...(outcome.parent ? { parentThreadId: "parent-thread", parentThreadBackend: "codex" as const } : {}),
    pendingStart: { startId: `card-${start}`, title: `Card ${start}`, directoryKey: `directory:/repo/project-${start}` },
  }).then(
    (response) => { log.push({ kind: "settled", start, ok: true, setupFailure: Boolean(response.codexEnvironmentStartupFailure) }); },
    () => { log.push({ kind: "settled", start, ok: false, setupFailure: false }); },
  ));
  await scheduler.waitFor(Promise.all(runs));
  await registry.close();
  return log;
}

function expectStartOrder(log: readonly LogEntry[], start: number, outcome: Outcome): void {
  const at = (predicate: (entry: LogEntry) => boolean): number => log.findIndex(predicate);
  const ours = (entry: LogEntry): boolean => "start" in entry && entry.start === start;
  const pending = log.filter((entry): entry is Extract<LogEntry, { kind: "pending" }> => entry.kind === "pending" && entry.start === start);
  const created = outcome.worktree === "ok" && outcome.provider === "ok";
  const threadId = `thread-${start}`;

  // Reported before any workspace work, and before anything else of this start.
  expect(pending[0]?.phase, `start ${start} reports starting first`).toBe("starting");
  expect(log.findIndex(ours)).toBe(log.indexOf(pending[0]!));

  // Ended exactly once, last of its reports, after any rollback, before the caller hears.
  const ended = pending.filter((entry) => entry.phase === "ended");
  expect(ended, `start ${start} ends once`).toHaveLength(1);
  expect(pending.at(-1)).toBe(ended[0]);
  const endedAt = log.indexOf(ended[0]!);
  const rollbackAt = at((entry) => ours(entry) && entry.kind === "effect" && entry.effect === "rollback");
  if (rollbackAt >= 0) expect(rollbackAt).toBeLessThan(endedAt);
  expect(endedAt).toBeLessThan(at((entry) => entry.kind === "settled" && entry.start === start));

  const landed = pending.filter((entry) => entry.phase === "landed");
  if (!created) {
    expect(landed, `start ${start} never lands without a thread`).toHaveLength(0);
    expect(ended[0]!.createdThreadId).toBeUndefined();
    // A refused provider still rolls the prepared worktree back.
    if (outcome.worktree === "ok") expect(rollbackAt).toBeGreaterThanOrEqual(0);
    return;
  }
  expect(landed, `start ${start} lands once`).toHaveLength(1);
  expect(landed[0]!.createdThreadId).toBe(threadId);
  expect(ended[0]!.createdThreadId).toBe(threadId);
  expect(ended[0]!.setupFailure).toBe(outcome.setup === "failed" ? "echo setup exited 1" : undefined);
  const landedAt = log.indexOf(landed[0]!);
  expect(landedAt).toBeGreaterThan(at((entry) => ours(entry) && entry.kind === "effect" && entry.effect === "provided"));
  const parentSetAt = at((entry) => entry.kind === "parent-set" && entry.threadId === threadId);
  if (parentSetAt >= 0) expect(landedAt).toBeLessThan(parentSetAt);
  expect(rollbackAt).toBe(-1);
  // The setup's failure stays on the started thread.
  const settled = log.find((entry): entry is Extract<LogEntry, { kind: "settled" }> => entry.kind === "settled" && entry.start === start)!;
  expect(settled).toMatchObject({ ok: true, setupFailure: outcome.setup === "failed" });
}

function expectInFlightStarts(log: readonly LogEntry[]): void {
  for (const entry of log) {
    if (entry.kind !== "snapshot") continue;
    expect(entry.starts.includes(`card-${entry.start}`)).toBe(entry.phase !== "ended");
  }
}

function expectSetupProgress(log: readonly LogEntry[], outcomes: readonly Outcome[]): void {
  outcomes.forEach((outcome, start) => {
    const progress = log.filter((entry) => entry.kind === "progress" && entry.start === start);
    expect(progress).toEqual(outcome.worktree === "ok" && outcome.setup !== "none"
      ? [{ kind: "progress", start, output: `setup for ${start}` }]
      : []);
  });
}

describe("pending thread start reports", () => {
  it("cover a start from before its worktree until its thread lands, in every interleaving", async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), fc.array(outcomeArbitrary, { minLength: 1, maxLength: 3 }), async (scheduler, outcomes) => {
        const log = await runStarts(scheduler, outcomes);
        outcomes.forEach((outcome, start) => expectStartOrder(log, start, outcome));
      }),
      { numRuns: 40 },
    );
  });

  const oneSetup: Outcome = { worktree: "ok", setup: "ok", provider: "ok", parent: false };

  it("late windows can read exactly the starts that have not ended", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.array(outcomeArbitrary, { minLength: 1, maxLength: 3 }),
      async (scheduler, outcomes) => expectInFlightStarts(await runStarts(scheduler, outcomes))), { numRuns: 25 });
  });

  it("a window opening during one start sees that start until ended", async () => {
    expectInFlightStarts(await runStarts(fc.schedulerFor([1, 2]), [{ ...oneSetup, setup: "none" }]));
  });

  it("keys setup output to the right start during concurrent preparations", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.array(outcomeArbitrary, { minLength: 1, maxLength: 3 }),
      async (scheduler, outcomes) => expectSetupProgress(await runStarts(scheduler, outcomes), outcomes)), { numRuns: 25 });
  });

  it("one setup chunk is visible before its thread exists", async () => {
    expectSetupProgress(await runStarts(fc.schedulerFor([1, 2, 3]), [oneSetup]), [oneSetup]);
  });

  it("keeps a failed setup on the terminal report after the thread is created", async () => {
    const failedSetup = { ...oneSetup, setup: "failed" as const };
    expectStartOrder(await runStarts(fc.schedulerFor([1, 2, 3]), [failedSetup]), 0, failedSetup);
  });

  it("reports nothing for a start that asks for no row", async () => {
    const events: string[] = [];
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        prepareLaunchpadWorkspace: async () => ({ cwd: "/worktrees/0", workMode: "worktree" as const, repositoryPath: "/repo/project-0" }),
      } as never,
    });
    registry.onEvent((event) => { events.push(event.notification.method); });
    await registry.startThread({ backend: "codex", cwd: "/repo/project-0", workMode: "worktree" });
    expect(events).not.toContain("thread/start/pending");
    await registry.close();
  });

  it("keeps the row descriptor out of the provider's thread/start request", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    await registry.startThread({ backend: "codex", cwd: "/repo/project-0", pendingStart: { startId: "card-0", title: "Card 0" } });
    expect(codexClient.lastStartThreadParams).not.toHaveProperty("pendingStart");
    await registry.close();
  });
});
