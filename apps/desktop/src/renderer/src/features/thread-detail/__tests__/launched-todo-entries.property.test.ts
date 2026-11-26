import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ThreadLaunchedThread } from "@pwragent/shared/contracts/navigation";
import type {
  AppServerBackendKind,
  AppServerThreadEntry,
  AppServerThreadTurnMetadata,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  ListThreadTodosRequest,
  ListThreadTodosResponse,
  ThreadTodo,
  ThreadTodoStatus,
  ThreadTodosChangedEvent,
} from "@pwragent/shared/contracts/thread-todos";
import { anchorTurnUsageEntries } from "@pwragent/shared/thread-usage-display";
import {
  buildLaunchedThreadPresentation,
  buildLaunchedTodoPresentation,
  filterAndMergeLaunchedTodos,
  injectLaunchedThreads,
  injectLaunchedTodos,
  isLaunchedTodo,
  isLaunchedTodoEntry,
  LAUNCHED_TODO_ENTRY_PREFIX,
  LaunchedTodosController,
  launchedTodosTargetKey,
  launchedTodoTimestamp,
  mergeLaunchedThreadRecords,
  resolveLaunchedTodoLinkRef,
  visibleLaunchedTodosForWindow,
  type LaunchedTodo,
  type LaunchedTodosSnapshot,
  type LaunchedTodosTarget,
} from "../launched-todo-entries";
import {
  buildTranscriptRenderItems,
  type TranscriptRenderItem,
} from "../transcript-render-items";

const BACKENDS: readonly AppServerBackendKind[] = [
  "codex",
  "claude",
  "acp:antigravity",
  "acp:grok",
];

const THREAD_POOL: readonly LaunchedTodosTarget[] = [
  { backend: "codex", threadId: "local-1" },
  { backend: "acp:antigravity", threadId: "local-2" },
  { backend: "claude", threadId: "remote-a", federationTarget: { scope: "remote", instanceId: "peer-a" } },
  { backend: "codex", threadId: "remote-b", federationTarget: { scope: "remote", instanceId: "peer-b" } },
];

type OwnerMode = "ok" | "busy-error" | "busy-threads" | "hard-error";

type PendingFetch = {
  id: number;
  request: ListThreadTodosRequest;
  responseTodos: ThreadTodo[];
  mode: OwnerMode;
  resolve: (response: ListThreadTodosResponse) => void;
  reject: (error: unknown) => void;
};

type ScheduledTimer = {
  id: number;
  fn: () => void;
  cancelled: boolean;
};

class ModelHarness {
  readonly ownerTodos = new Map<string, ThreadTodo[]>();
  readonly ownerModes = new Map<string, OwnerMode>();
  readonly pendingFetches: PendingFetch[] = [];
  readonly timers: ScheduledTimer[] = [];
  readonly snapshots: LaunchedTodosSnapshot[] = [];
  readonly fetchHistory: ListThreadTodosRequest[] = [];
  nextFetchId = 1;
  nextTimerId = 1;
  nextTodoId = 1;
  disposed = false;
  readonly controller: LaunchedTodosController;

  constructor() {
    this.controller = new LaunchedTodosController({
      listThreadTodos: (request) => {
        this.fetchHistory.push(request);
        const key = launchedTodosTargetKey(
          request.backend && request.threadId
            ? {
                backend: request.backend,
                threadId: request.threadId,
                ...(request.federationTarget ? { federationTarget: request.federationTarget } : {}),
              }
            : undefined,
        );
        const mode = (key ? this.ownerModes.get(key) : undefined) ?? "ok";
        // Snapshot the owner's cards at request dispatch time, plus occasional
        // stray cards from other threads/statuses to test filtering invariants.
        const responseTodos = key ? [...(this.ownerTodos.get(key) ?? [])] : [];
        return new Promise<ListThreadTodosResponse>((resolve, reject) => {
          this.pendingFetches.push({
            id: this.nextFetchId++,
            request,
            responseTodos,
            mode,
            resolve,
            reject,
          });
        });
      },
      scheduler: {
        setTimeout: (fn) => {
          const entry: ScheduledTimer = {
            id: this.nextTimerId++,
            fn,
            cancelled: false,
          };
          this.timers.push(entry);
          return entry;
        },
        clearTimeout: (handle) => {
          const entry = handle as ScheduledTimer;
          entry.cancelled = true;
        },
      },
      busyRetryMs: 1_000,
      onStateChange: (snapshot) => {
        this.snapshots.push(snapshot);
      },
    });
  }

  oracleFor(target: LaunchedTodosTarget | undefined): LaunchedTodo[] {
    if (!target) {
      return [];
    }
    const key = launchedTodosTargetKey(target)!;
    const raw = this.ownerTodos.get(key) ?? [];
    return filterAndMergeLaunchedTodos({
      fetched: raw,
      scope: {
        backend: target.backend,
        threadId: target.threadId,
        ...(target.federationTarget ? { instanceId: target.federationTarget.instanceId } : {}),
      },
    });
  }

  settleFetch(index: number): void {
    if (this.pendingFetches.length === 0) {
      return;
    }
    const clamped = index % this.pendingFetches.length;
    const [pending] = this.pendingFetches.splice(clamped, 1);
    if (!pending) {
      return;
    }
    if (pending.mode === "busy-error") {
      pending.reject(Object.assign(new Error("Owner busy"), { code: "navigation_busy" }));
      return;
    }
    if (pending.mode === "hard-error") {
      pending.reject(new Error("Peer offline"));
      return;
    }
    if (pending.mode === "busy-threads" && pending.request.federationTarget && pending.request.backend && pending.request.threadId) {
      pending.resolve({
        todos: [],
        busyThreads: [{
          federationTarget: pending.request.federationTarget,
          backend: pending.request.backend,
          threadId: pending.request.threadId,
        }],
      });
      return;
    }
    pending.resolve({ todos: pending.responseTodos });
  }

  fireNextTimer(): void {
    const active = this.timers.find((timer) => !timer.cancelled);
    if (!active) {
      return;
    }
    active.cancelled = true;
    active.fn();
  }
}

type LoaderModel = {
  target: LaunchedTodosTarget | undefined;
  disposed: boolean;
  lastEmittedCount: number;
};

function makeLaunchedTodo(params: {
  id: string;
  target: LaunchedTodosTarget;
  startedBackend: AppServerBackendKind;
  startedThreadId: string;
  resolvedAt: number;
  createdAt?: number;
  title?: string;
  detail?: string;
  prompt?: string;
  setupFailure?: string;
}): LaunchedTodo {
  const createdAt = params.createdAt ?? Math.max(1, params.resolvedAt - 10);
  return {
    id: params.id,
    backend: params.target.backend,
    threadId: params.target.threadId,
    ...(params.target.federationTarget ? { federationTarget: params.target.federationTarget } : {}),
    kind: "handoff",
    status: "done",
    title: params.title ?? `Launch ${params.id}`,
    ...(params.detail ? { detail: params.detail } : {}),
    action: {
      type: "start_thread",
      prompt: params.prompt ?? `Prompt for ${params.id}`,
    },
    result: "Started thread",
    startedThread: {
      backend: params.startedBackend,
      threadId: params.startedThreadId,
      ...(params.setupFailure ? { setupFailure: params.setupFailure } : {}),
    },
    createdAt,
    updatedAt: params.resolvedAt,
    resolvedAt: params.resolvedAt,
  };
}

function assertSnapshotInvariants(harness: ModelHarness, model: LoaderModel): void {
  const snap = harness.controller.getSnapshot();
  expect(snap.threadKey).toBe(launchedTodosTargetKey(model.target));

  // No cross-thread leakage, no non-launched cards, no duplicate ids, canonical order.
  const seenIds = new Set<string>();
  for (let index = 0; index < snap.todos.length; index += 1) {
    const todo = snap.todos[index]!;
    expect(isLaunchedTodo(todo)).toBe(true);
    expect(seenIds.has(todo.id)).toBe(false);
    seenIds.add(todo.id);
    if (model.target) {
      expect(todo.backend).toBe(model.target.backend);
      expect(todo.threadId).toBe(model.target.threadId);
      expect(todo.federationTarget?.instanceId).toBe(model.target.federationTarget?.instanceId);
    }
    if (index > 0) {
      const prev = snap.todos[index - 1]!;
      const prevAt = launchedTodoTimestamp(prev);
      const currAt = launchedTodoTimestamp(todo);
      expect(prevAt <= currAt).toBe(true);
      if (prevAt === currAt && prev.createdAt === todo.createdAt) {
        expect(prev.id.localeCompare(todo.id) <= 0).toBe(true);
      }
    }
  }
  if (!model.target) {
    expect(snap.todos).toEqual([]);
  }
  if (model.disposed) {
    expect(harness.snapshots.length).toBe(model.lastEmittedCount);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("LaunchedTodosController model-based tests", () => {
  it("preserves cross-thread isolation, busy/error retention, and eventual consistency across arbitrary interleavings", async () => {
    const targetArb = fc.option(fc.constantFrom(...THREAD_POOL), { nil: undefined });
    const modeArb = fc.constantFrom<OwnerMode>("ok", "busy-error", "busy-threads", "hard-error");
    const backendArb = fc.constantFrom(...BACKENDS);

    const commandsArb = fc.commands<LoaderModel, ModelHarness, true>(
      [
        // 1. Switch selected thread (including rapid A -> B -> A and clearing to undefined).
        targetArb.map((nextTarget) => ({
          check: async () => true,
          run: async (model, harness) => {
            harness.controller.setTarget(nextTarget);
            if (!model.disposed) {
              model.target = nextTarget;
            }
            await flushMicrotasks();
            assertSnapshotInvariants(harness, model);
          },
          toString: () => `SelectThread(${launchedTodosTargetKey(nextTarget) ?? "none"})`,
        })),

        // 2. Owner records a newly launched to-do and optionally emits onThreadTodosChanged.
        fc.record({
          target: fc.constantFrom(...THREAD_POOL),
          startedBackend: backendArb,
          resolvedAt: fc.integer({ min: 1_000, max: 9_000 }),
          notify: fc.boolean(),
        }).map((spec) => ({
          check: async () => true,
          run: async (model, harness) => {
            const key = launchedTodosTargetKey(spec.target)!;
            const id = `todo-${harness.nextTodoId++}`;
            const todo = makeLaunchedTodo({
              id,
              target: spec.target,
              startedBackend: spec.startedBackend,
              startedThreadId: `child-${id}`,
              resolvedAt: spec.resolvedAt,
            });
            harness.ownerTodos.set(key, [...(harness.ownerTodos.get(key) ?? []), todo]);
            if (spec.notify) {
              const event: ThreadTodosChangedEvent = {
                at: spec.resolvedAt,
                backend: spec.target.backend,
                threadId: spec.target.threadId,
                ...(spec.target.federationTarget ? { federationTarget: spec.target.federationTarget } : {}),
              };
              const beforeFetches = harness.fetchHistory.length;
              const isUnrelated = model.target !== undefined
                && !model.disposed
                && launchedTodosTargetKey(model.target) !== key;
              harness.controller.handleTodosChanged(event);
              if (isUnrelated) {
                expect(harness.fetchHistory.length).toBe(beforeFetches);
              }
            }
            await flushMicrotasks();
            assertSnapshotInvariants(harness, model);
          },
          toString: () => `LaunchTodo(${launchedTodosTargetKey(spec.target)}, notify=${spec.notify})`,
        })),

        // 3. Owner adds a non-qualifying card (open, dismissed, done without startedThread, or wrong thread).
        fc.record({
          target: fc.constantFrom(...THREAD_POOL),
          status: fc.constantFrom<ThreadTodoStatus>("open", "done", "dismissed"),
          wrongThread: fc.boolean(),
        }).map((spec) => ({
          check: async () => true,
          run: async (model, harness) => {
            const key = launchedTodosTargetKey(spec.target)!;
            const id = `nonlaunch-${harness.nextTodoId++}`;
            const card: ThreadTodo = {
              id,
              backend: spec.target.backend,
              threadId: spec.wrongThread ? "stranger-thread" : spec.target.threadId,
              ...(spec.target.federationTarget ? { federationTarget: spec.target.federationTarget } : {}),
              kind: "reminder",
              status: spec.status,
              title: "Noise card",
              createdAt: 500,
              updatedAt: 500,
              ...(spec.status !== "open" ? { resolvedAt: 600 } : {}),
              ...(spec.status === "open"
                ? { startedThread: { backend: "codex", threadId: "should-never-show" } }
                : {}),
            };
            harness.ownerTodos.set(key, [...(harness.ownerTodos.get(key) ?? []), card]);
            await flushMicrotasks();
            assertSnapshotInvariants(harness, model);
          },
          toString: () => `AddNoiseCard(${spec.status}, wrongThread=${spec.wrongThread})`,
        })),

        // 4. Owner mode toggles (healthy, busy rejection, busyThreads payload, hard error).
        fc.record({
          target: fc.constantFrom(...THREAD_POOL),
          mode: modeArb,
        }).map((spec) => ({
          check: async () => true,
          run: async (model, harness) => {
            harness.ownerModes.set(launchedTodosTargetKey(spec.target)!, spec.mode);
            assertSnapshotInvariants(harness, model);
          },
          toString: () => `SetOwnerMode(${launchedTodosTargetKey(spec.target)}, ${spec.mode})`,
        })),

        // 5. Settle an arbitrary pending fetch (out-of-order IPC completion!).
        fc.nat({ max: 10 }).map((pick) => ({
          check: async () => true,
          run: async (model, harness) => {
            const beforeTodos = harness.controller.getSnapshot().todos;
            const beforeKey = harness.controller.getSnapshot().threadKey;
            const picked = harness.pendingFetches.length > 0
              ? harness.pendingFetches[pick % harness.pendingFetches.length]
              : undefined;
            harness.settleFetch(pick);
            await flushMicrotasks();
            // Transient errors or busy responses must never wipe cards already shown for the same thread.
            if (
              picked
              && picked.mode !== "ok"
              && !model.disposed
              && harness.controller.getSnapshot().threadKey === beforeKey
            ) {
              expect(harness.controller.getSnapshot().todos).toEqual(beforeTodos);
            }
            assertSnapshotInvariants(harness, model);
          },
          toString: () => `SettleFetch(${pick})`,
        })),

        // 6. Fire an explicit global or targeted change event.
        fc.record({
          global: fc.boolean(),
          target: fc.constantFrom(...THREAD_POOL),
        }).map((spec) => ({
          check: async () => true,
          run: async (model, harness) => {
            const event: ThreadTodosChangedEvent = spec.global
              ? { at: Date.now() }
              : {
                  at: Date.now(),
                  backend: spec.target.backend,
                  threadId: spec.target.threadId,
                  ...(spec.target.federationTarget ? { federationTarget: spec.target.federationTarget } : {}),
                };
            harness.controller.handleTodosChanged(event);
            await flushMicrotasks();
            assertSnapshotInvariants(harness, model);
          },
          toString: () => `FireChanged(global=${spec.global}, ${launchedTodosTargetKey(spec.target)})`,
        })),

        // 7. Fire next scheduled busy-retry timer.
        fc.constant({
          check: async () => true,
          run: async (model, harness) => {
            harness.fireNextTimer();
            await flushMicrotasks();
            assertSnapshotInvariants(harness, model);
          },
          toString: () => "FireRetryTimer",
        }),

        // 8. Dispose controller and verify silence afterwards.
        fc.constant({
          check: async (model: Readonly<LoaderModel>) => !model.disposed,
          run: async (model: LoaderModel, harness: ModelHarness) => {
            harness.controller.dispose();
            model.disposed = true;
            model.lastEmittedCount = harness.snapshots.length;
            await flushMicrotasks();
            assertSnapshotInvariants(harness, model);
          },
          toString: () => "Dispose",
        }),
      ],
      { maxCommands: 25, size: "max" },
    );

    await fc.assert(
      fc.asyncProperty(commandsArb, async (commands) => {
        const harness = new ModelHarness();
        const model: LoaderModel = {
          target: undefined,
          disposed: false,
          lastEmittedCount: 0,
        };
        await fc.asyncModelRun(() => ({ model, real: harness }), commands);

        // Quiescence oracle: if not disposed and owner becomes healthy, triggering
        // a refresh and draining all fetches converges to the exact owner oracle.
        if (!model.disposed && model.target) {
          harness.ownerModes.set(launchedTodosTargetKey(model.target)!, "ok");
          harness.controller.handleTodosChanged({
            at: 99_999,
            backend: model.target.backend,
            threadId: model.target.threadId,
            ...(model.target.federationTarget ? { federationTarget: model.target.federationTarget } : {}),
          });
          let guard = 0;
          while (harness.pendingFetches.length > 0 && guard < 30) {
            harness.settleFetch(0);
            await flushMicrotasks();
            guard += 1;
          }
          expect(harness.controller.getSnapshot().todos).toEqual(harness.oracleFor(model.target));
        }
      }),
    );
  });

  it("caps busy retries at one per cycle, resets on change events, and survives ABA thread switches", async () => {
    const harness = new ModelHarness();
    const t1 = THREAD_POOL[0]!;
    const t2 = THREAD_POOL[1]!;
    const cardA = makeLaunchedTodo({
      id: "aba-a",
      target: t1,
      startedBackend: "claude",
      startedThreadId: "child-a",
      resolvedAt: 1_000,
    });
    const cardB = makeLaunchedTodo({
      id: "aba-b",
      target: t1,
      startedBackend: "claude",
      startedThreadId: "child-b",
      resolvedAt: 2_000,
    });

    // ABA switch: start T1 (captures only cardA), switch to T2, launch cardB on T1, switch back to T1.
    harness.ownerTodos.set(launchedTodosTargetKey(t1)!, [cardA]);
    harness.controller.setTarget(t1);
    expect(harness.pendingFetches).toHaveLength(1);
    harness.controller.setTarget(t2);
    harness.ownerTodos.set(launchedTodosTargetKey(t1)!, [cardA, cardB]);
    harness.controller.setTarget(t1);
    expect(harness.pendingFetches).toHaveLength(3);

    // Resolve the newest T1 fetch first, then the stale first T1 fetch!
    harness.settleFetch(2);
    await flushMicrotasks();
    expect(harness.controller.getSnapshot().todos.map((t) => t.id)).toEqual(["aba-a", "aba-b"]);

    harness.settleFetch(0);
    await flushMicrotasks();
    // Stale first T1 fetch must NOT overwrite the newer T1 data!
    expect(harness.controller.getSnapshot().todos.map((t) => t.id)).toEqual(["aba-a", "aba-b"]);

    // Busy retry budget: one retry scheduled, not an infinite loop.
    harness.ownerModes.set(launchedTodosTargetKey(t1)!, "busy-error");
    harness.controller.handleTodosChanged({ at: 3_000, backend: t1.backend, threadId: t1.threadId });
    harness.settleFetch(harness.pendingFetches.length - 1);
    await flushMicrotasks();
    expect(harness.timers.filter((t) => !t.cancelled)).toHaveLength(1);
    // Existing cards are preserved on busy failure.
    expect(harness.controller.getSnapshot().todos.map((t) => t.id)).toEqual(["aba-a", "aba-b"]);

    harness.fireNextTimer();
    harness.settleFetch(harness.pendingFetches.length - 1);
    await flushMicrotasks();
    // Second consecutive busy failure in the same cycle does NOT schedule another timer.
    expect(harness.timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });
});

describe("injectLaunchedTodos transcript order and pagination properties", () => {
  const entryArb: fc.Arbitrary<AppServerThreadEntry> = fc.record({
    id: fc.integer({ min: 1, max: 9_999 }).map((n) => `entry-${n}`),
    kind: fc.constantFrom<"user" | "assistant" | "activity">("user", "assistant", "activity"),
    createdAt: fc.option(fc.integer({ min: 100, max: 1_000 }), { nil: undefined }),
  }).map((spec): AppServerThreadEntry => {
    if (spec.kind === "activity") {
      return {
        type: "activity",
        id: spec.id,
        summary: `Activity ${spec.id}`,
        status: "completed",
        details: [],
        ...(spec.createdAt !== undefined ? { createdAt: spec.createdAt } : {}),
      };
    }
    return {
      type: "message",
      id: spec.id,
      role: spec.kind,
      text: `Message ${spec.id}`,
      ...(spec.createdAt !== undefined ? { createdAt: spec.createdAt } : {}),
    };
  });

  const todoArb: fc.Arbitrary<ThreadTodo> = fc.record({
    id: fc.integer({ min: 1, max: 20 }).map((n) => `todo-${n}`),
    status: fc.constantFrom<ThreadTodoStatus>("open", "done", "dismissed"),
    hasStarted: fc.boolean(),
    blankThreadId: fc.boolean(),
    createdAt: fc.integer({ min: 10, max: 500 }),
    resolvedAt: fc.option(fc.integer({ min: 50, max: 1_200 }), { nil: undefined }),
    updatedAt: fc.integer({ min: 50, max: 1_200 }),
  }).map((spec): ThreadTodo => ({
    id: spec.id,
    backend: "codex",
    threadId: "t-1",
    kind: spec.hasStarted ? "handoff" : "reminder",
    status: spec.status,
    title: `Card ${spec.id}`,
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
    ...(spec.resolvedAt !== undefined ? { resolvedAt: spec.resolvedAt } : {}),
    ...(spec.hasStarted
      ? {
          startedThread: {
            backend: "acp:antigravity",
            threadId: spec.blankThreadId ? "   " : `started-${spec.id}`,
          },
        }
      : {}),
  }));

  it("never reorders original entries, deduplicates ids, and respects pagination bounds", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(entryArb, { maxLength: 16, selector: (entry) => entry.id }),
        fc.array(todoArb, { maxLength: 14 }),
        fc.boolean(),
        (entries, todos, hasPreviousPage) => {
          const merged = injectLaunchedTodos(entries, todos, { hasPreviousPage });

          // Original transcript entries stay in their exact input order.
          const withoutLaunched = merged.filter((entry) => !isLaunchedTodoEntry(entry));
          expect(withoutLaunched).toEqual(entries);

          // Injected launched entries are unique and every one is qualifying.
          const injected = merged.filter(isLaunchedTodoEntry);
          const injectedIds = injected.map((entry) => entry.id);
          expect(new Set(injectedIds).size).toBe(injectedIds.length);

          if (entries.length === 0) {
            expect(injected).toEqual([]);
            return;
          }

          const expected = visibleLaunchedTodosForWindow(entries, todos, { hasPreviousPage });
          expect(injectedIds).toEqual(expected.map((todo) => `${LAUNCHED_TODO_ENTRY_PREFIX}${todo.id}`));

          // Every injected row sits before any strictly later timed entry it precedes,
          // and never before a strictly earlier timed entry that was already placed earlier.
          for (let index = 0; index < merged.length; index += 1) {
            const entry = merged[index]!;
            if (!isLaunchedTodoEntry(entry)) {
              continue;
            }
            const at = entry.createdAt!;
            // The next timed non-synthetic entry (if any) must be strictly later than `at`.
            for (let next = index + 1; next < merged.length; next += 1) {
              const candidate = merged[next]!;
              if (!isLaunchedTodoEntry(candidate) && typeof candidate.createdAt === "number") {
                expect(candidate.createdAt).toBeGreaterThan(at);
                break;
              }
            }
          }

          // Pagination monotonicity: removing `hasPreviousPage` can only reveal more cards,
          // never hide a previously visible one.
          if (hasPreviousPage) {
            const full = visibleLaunchedTodosForWindow(entries, todos, { hasPreviousPage: false });
            const fullIds = new Set(full.map((todo) => todo.id));
            for (const item of expected) {
              expect(fullIds.has(item.id)).toBe(true);
            }
          }
        },
      ),
    );
  });

  it("respects prependAnchorId when an older prompt is pinned above a partial tail window", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 100 }),
        fc.integer({ min: 500, max: 900 }),
        fc.array(fc.integer({ min: 1, max: 1_200 }), { minLength: 1, maxLength: 10 }),
        (pinnedAt, tailAt, launchTimes) => {
          const entries: AppServerThreadEntry[] = [
            { type: "message", id: "pinned-prompt", role: "user", text: "First", createdAt: pinnedAt },
            { type: "message", id: "tail-start", role: "assistant", text: "Recent", createdAt: tailAt },
          ];
          const todos = launchTimes.map((at, index) => makeLaunchedTodo({
            id: `l-${index}`,
            target: { backend: "codex", threadId: "t-1" },
            startedBackend: "claude",
            startedThreadId: `c-${index}`,
            resolvedAt: at,
          }));
          const visible = visibleLaunchedTodosForWindow(entries, todos, {
            hasPreviousPage: true,
            prependAnchorId: "tail-start",
          });
          for (const todo of visible) {
            expect(launchedTodoTimestamp(todo)).toBeGreaterThanOrEqual(tailAt);
          }
          const expectedCount = launchTimes.filter((at) => at >= tailAt).length;
          expect(visible).toHaveLength(expectedCount);
        },
      ),
    );
  });
});

describe("buildTranscriptRenderItems and turn-usage anchoring with launched to-dos", () => {
  type TurnStep = "tool" | "edit" | "commentary" | "reply";

  const turnSpecArb = fc.record({
    status: fc.constantFrom<"completed" | "cancelled">("completed", "cancelled"),
    steps: fc.array(fc.constantFrom<TurnStep>("tool", "edit", "commentary", "reply"), { minLength: 1, maxLength: 5 }),
    includeFinal: fc.boolean(),
    includeUsage: fc.boolean(),
  });

  function renderShape(items: TranscriptRenderItem[]): string[] {
    return items.map((item) => (
      item.type === "workPhaseGroup"
        ? `group[${item.label}:${item.defaultExpanded ? "open" : "closed"}](${item.entries.map((entry) => entry.id).join(",")})`
        : `entry:${item.entry.id}`
    ));
  }

  it("keeps every launched to-do at top level without splitting or altering any work group or turn usage row", () => {
    fc.assert(
      fc.property(
        fc.array(turnSpecArb, { minLength: 1, maxLength: 3 }),
        fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:antigravity"),
        fc.array(fc.integer({ min: 0, max: 2_000 }), { minLength: 1, maxLength: 5 }),
        fc.boolean(),
        (turnSpecs, backend, launchTimes, hasActiveTurn) => {
          const baseEntries: AppServerThreadEntry[] = [];
          let clock = 100;
          turnSpecs.forEach((spec, turnIndex) => {
            const turnId = `turn-${turnIndex}`;
            const turn: AppServerThreadTurnMetadata = {
              id: turnId,
              status: spec.status,
              startedAt: clock,
              completedAt: clock + 90_000,
              durationMs: 90_000,
            };
            baseEntries.push({
              type: "message",
              id: `u-${turnIndex}`,
              role: "user",
              text: `Prompt ${turnIndex}`,
              createdAt: clock,
              turn,
            });
            clock += 100;
            spec.steps.forEach((step, stepIndex) => {
              const id = `s-${turnIndex}-${stepIndex}`;
              if (step === "tool") {
                baseEntries.push({
                  type: "activity",
                  id,
                  summary: "Ran command",
                  status: "completed",
                  createdAt: clock,
                  details: [{ id: `${id}-d`, kind: "command", label: "pnpm test", status: "completed" }],
                  turn,
                });
              } else if (step === "edit") {
                baseEntries.push({
                  type: "activity",
                  id,
                  summary: "Edited file",
                  status: "completed",
                  createdAt: clock,
                  details: [{ id: `${id}-d`, kind: "write", label: "src/a.ts", path: "src/a.ts", status: "completed" }],
                  turn,
                });
              } else {
                baseEntries.push({
                  type: "message",
                  id,
                  role: "assistant",
                  text: `Step ${stepIndex}`,
                  createdAt: clock,
                  ...(step === "commentary" ? { phase: "commentary" as const } : {}),
                  turn,
                });
              }
              clock += 50;
            });
            if (spec.includeFinal) {
              baseEntries.push({
                type: "message",
                id: `f-${turnIndex}`,
                role: "assistant",
                phase: "final",
                text: "Final answer.",
                createdAt: clock,
                turn,
              });
              clock += 50;
            }
            if (spec.includeUsage) {
              baseEntries.push({
                type: "activity",
                id: `live-turn-usage-${turnId}`,
                summary: "Turn usage: 100 uncached in",
                status: "completed",
                createdAt: clock,
                details: [],
                turn,
              });
              clock += 50;
            }
          });

          const activeTurnId = hasActiveTurn ? `turn-${turnSpecs.length}` : undefined;
          if (activeTurnId) {
            const activeTurn: AppServerThreadTurnMetadata = {
              id: activeTurnId,
              status: "in_progress",
              startedAt: clock,
            };
            baseEntries.push(
              { type: "message", id: "u-active", role: "user", text: "Live", createdAt: clock, turn: activeTurn },
              {
                type: "activity",
                id: "t-active-1",
                summary: "Reading",
                status: "completed",
                createdAt: clock + 50,
                details: [{ id: "d1", kind: "read", label: "a.ts", status: "completed" }],
                turn: activeTurn,
              },
              {
                type: "activity",
                id: "t-active-2",
                summary: "Running",
                status: "in_progress",
                createdAt: clock + 100,
                details: [{ id: "d2", kind: "command", label: "pnpm test", status: "in_progress" }],
                turn: activeTurn,
              },
            );
          }

          const launchedTodos = launchTimes.map((at, index) => makeLaunchedTodo({
            id: `lt-${index}`,
            target: { backend, threadId: "t-main" },
            startedBackend: "codex",
            startedThreadId: `child-${index}`,
            resolvedAt: at,
          }));

          const withoutEntries = anchorTurnUsageEntries(baseEntries);
          const withEntries = anchorTurnUsageEntries(injectLaunchedTodos(baseEntries, launchedTodos));

          const render = (entries: AppServerThreadEntry[]) => buildTranscriptRenderItems({
            entries,
            backend,
            ...(activeTurnId ? { activeTurnId, activeTurnStartedAt: clock } : {}),
            now: clock + 120_000,
          });
          const withoutItems = render(withoutEntries);
          const withItems = render(withEntries);

          // Every launched to-do renders as a standalone top-level entry (never inside a group).
          const launchedRenderItems = withItems.filter(
            (item) => item.type === "entry" && isLaunchedTodoEntry(item.entry),
          );
          expect(launchedRenderItems).toHaveLength(launchedTodos.length);
          for (const item of withItems) {
            if (item.type === "workPhaseGroup") {
              expect(item.entries.some(isLaunchedTodoEntry)).toBe(false);
            }
          }

          // For non-Antigravity backends (Antigravity edit batching intentionally flushes
          // edit runs across an intervening row), every other render item stays identical.
          if (backend !== "acp:antigravity") {
            expect(
              renderShape(withItems).filter((label) => !label.startsWith(`entry:${LAUNCHED_TODO_ENTRY_PREFIX}`)),
            ).toEqual(renderShape(withoutItems));
          } else {
            // Even on Antigravity, group count and collapsed-group membership of non-edit entries never break.
            const nonLaunchedWithout = withoutItems.filter((item) => item.type === "entry").map((item) => item.entry.id);
            const nonLaunchedWith = withItems
              .filter((item): item is Extract<TranscriptRenderItem, { type: "entry" }> => (
                item.type === "entry" && !isLaunchedTodoEntry(item.entry)
              ))
              .map((item) => item.entry.id);
            expect(nonLaunchedWith).toEqual(nonLaunchedWithout);
          }
        },
      ),
    );
  });
});

describe("resolveLaunchedTodoLinkRef federation and window-frame oracle", () => {
  const LOCAL = "pwr_local";
  const PEER_A = "pwr_peer_a";
  const PEER_B = "pwr_peer_b";

  it("canonicalizes machine ownership across main and remote viewer windows for all combinations", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<string | undefined>(undefined, PEER_A, PEER_B),
        fc.constantFrom<string | undefined>(LOCAL, undefined),
        fc.constantFrom<string | undefined>(undefined, PEER_A, PEER_B),
        fc.constantFrom<string | undefined>(undefined, LOCAL, PEER_A, PEER_B),
        fc.option(fc.constantFrom("M5 Max", "Linux Box", "  "), { nil: undefined }),
        fc.option(fc.constantFrom("Action Title", "  "), { nil: undefined }),
        fc.constantFrom("Card Title", "  "),
        fc.constantFrom(...BACKENDS),
        (
          windowOwnerInstanceId,
          localInstanceId,
          cardOwnerInstanceId,
          startedInstanceId,
          startedInstanceLabel,
          actionTitle,
          cardTitle,
          startedBackend,
        ) => {
          const todo: LaunchedTodo = {
            id: "todo-1",
            backend: "codex",
            threadId: "parent-1",
            ...(cardOwnerInstanceId
              ? { federationTarget: { scope: "remote", instanceId: cardOwnerInstanceId } }
              : {}),
            kind: "handoff",
            status: "done",
            title: cardTitle,
            action: {
              type: "start_thread",
              prompt: "Do work",
              ...(actionTitle !== undefined ? { title: actionTitle } : {}),
            },
            startedThread: {
              backend: startedBackend,
              threadId: "started-1",
              ...(startedInstanceId ? { instanceId: startedInstanceId } : {}),
              ...(startedInstanceLabel !== undefined ? { instanceLabel: startedInstanceLabel } : {}),
            },
            createdAt: 1,
            updatedAt: 2,
            resolvedAt: 2,
          };

          const ref = resolveLaunchedTodoLinkRef({
            todo,
            localInstanceId,
            windowOwnerInstanceId,
          });

          const effectiveOwner = startedInstanceId ?? cardOwnerInstanceId;
          const expectedRefInstanceId = windowOwnerInstanceId
            ? (effectiveOwner && effectiveOwner !== windowOwnerInstanceId ? effectiveOwner : undefined)
            : (effectiveOwner && effectiveOwner !== localInstanceId ? effectiveOwner : undefined);

          expect(ref.backend).toBe(startedBackend);
          expect(ref.threadId).toBe("started-1");
          expect(ref.instanceId).toBe(expectedRefInstanceId);

          // instanceLabel only attaches when it names the resolved remote instance.
          const trimmedLabel = startedInstanceLabel?.trim() || undefined;
          const expectedLabel = expectedRefInstanceId && startedInstanceId === expectedRefInstanceId
            ? trimmedLabel
            : undefined;
          expect(ref.instanceLabel).toBe(expectedLabel);

          // fallbackLabel is always non-empty: action.title -> todo.title -> started.threadId.
          const expectedFallback = actionTitle?.trim() || cardTitle.trim() || "started-1";
          expect(ref.fallbackLabel).toBe(expectedFallback);
        },
      ),
    );
  });
});

describe("filterAndMergeLaunchedTodos and buildLaunchedTodoPresentation properties", () => {
  it("prefers authoritative fetched records over transient tray copies and builds clean copy/facts", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 6 }).map((n) => `t-${n}`),
            title: fc.constantFrom("Inspect evals", "Run benchmark", "Fix race"),
            detail: fc.option(fc.constantFrom("Check token replay", "   "), { nil: undefined }),
            prompt: fc.option(fc.constantFrom("Inspect /tmp/repo", "  "), { nil: undefined }),
            setupFailure: fc.option(fc.constantFrom("pnpm install exited 1", " "), { nil: undefined }),
            targetProjectLabel: fc.option(fc.constantFrom("t3code", "PwrSnap"), { nil: undefined }),
            stepCount: fc.integer({ min: 0, max: 4 }),
            prereqCount: fc.integer({ min: 0, max: 2 }),
            resolvedAt: fc.integer({ min: 100, max: 500 }),
            backend: fc.constantFrom(...BACKENDS),
          }),
          { maxLength: 10 },
        ),
        (specs) => {
          const scope = { backend: "codex" as const, threadId: "parent-1" };
          const fetched: ThreadTodo[] = specs.map((spec) => ({
            id: spec.id,
            backend: scope.backend,
            threadId: scope.threadId,
            kind: "handoff",
            status: "done",
            title: `Fetched: ${spec.title}`,
            ...(spec.detail !== undefined ? { detail: spec.detail } : {}),
            ...(spec.targetProjectLabel
              ? { targetProject: { key: `dir:${spec.targetProjectLabel}`, label: spec.targetProjectLabel, path: `/p/${spec.targetProjectLabel}` } }
              : {}),
            items: [
              ...Array.from({ length: spec.prereqCount }, (_, i) => ({
                id: `pre-${i}`,
                text: `Prereq ${i}`,
                checked: true,
                prerequisite: true as const,
              })),
              ...Array.from({ length: spec.stepCount }, (_, i) => ({
                id: `step-${i}`,
                text: `Step ${i}`,
                checked: false,
              })),
            ],
            ...(spec.prompt !== undefined ? { action: { type: "start_thread" as const, prompt: spec.prompt } } : {}),
            startedThread: {
              backend: spec.backend,
              threadId: `child-${spec.id}`,
              ...(spec.setupFailure !== undefined ? { setupFailure: spec.setupFailure } : {}),
            },
            createdAt: spec.resolvedAt - 10,
            updatedAt: spec.resolvedAt,
            resolvedAt: spec.resolvedAt,
          }));

          const transient: ThreadTodo[] = specs.map((spec) => ({
            ...fetched[0]!,
            id: spec.id,
            title: `Transient: ${spec.title}`,
            updatedAt: spec.resolvedAt + 999,
            resolvedAt: spec.resolvedAt + 999,
          }));

          const merged = filterAndMergeLaunchedTodos({ fetched, transient, scope });
          const uniqueIds = new Set(specs.map((spec) => spec.id));
          expect(merged).toHaveLength(uniqueIds.size);

          for (const todo of merged) {
            // Authoritative fetched always wins over transient even if transient has a later timestamp.
            expect(todo.title.startsWith("Fetched:")).toBe(true);
            const presentation = buildLaunchedTodoPresentation({ todo });
            expect(presentation.facts.every((fact) => fact.trim().length > 0)).toBe(true);
            expect(presentation.copyText).toContain(presentation.title);
            expect(presentation.copyText).toContain(todo.startedThread.threadId);
            expect(presentation.hasExpandableBody).toBe(
              Boolean(presentation.prompt || presentation.steps.length > 0 || presentation.setupFailure),
            );
            // Prerequisites are never listed as launched plan steps.
            expect(presentation.steps.every((step) => !step.prerequisite)).toBe(true);
          }
        },
      ),
    );
  });
});

describe("mergeLaunchedThreadRecords and injectLaunchedThreads unified properties", () => {
  it("deduplicates mixed to-do and tool launches by id/todoId/startedThread, prefers to-do cards, and preserves transcript invariants", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 5 }).map((n) => `todo-${n}`),
            childId: fc.integer({ min: 1, max: 6 }).map((n) => `child-${n}`),
            backend: fc.constantFrom(...BACKENDS),
            resolvedAt: fc.integer({ min: 100, max: 900 }),
          }),
          { maxLength: 8 },
        ),
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 6 }).map((n) => `tool-${n}`),
            source: fc.constantFrom<"handoff_task" | "create_instance_thread">(
              "handoff_task",
              "create_instance_thread",
            ),
            childId: fc.integer({ min: 1, max: 8 }).map((n) => `child-${n}`),
            backend: fc.constantFrom(...BACKENDS),
            occurredAt: fc.integer({ min: 50, max: 950 }),
            seedMode: fc.constantFrom<"clean" | "fork">("clean", "fork"),
            groupingMode: fc.constantFrom<"subthread" | "none">("subthread", "none"),
            corruptChild: fc.boolean(),
            todoIdRef: fc.option(fc.integer({ min: 1, max: 5 }).map((n) => `todo-${n}`), { nil: undefined }),
          }),
          { maxLength: 10 },
        ),
        fc.boolean(),
        (todoSpecs, toolSpecs, hasPreviousPage) => {
          const todos: ThreadTodo[] = todoSpecs.map((spec) => ({
            id: spec.id,
            backend: "codex",
            threadId: "parent-1",
            kind: "handoff",
            status: "done",
            title: `To-do ${spec.id}`,
            startedThread: { backend: spec.backend, threadId: spec.childId },
            createdAt: spec.resolvedAt - 10,
            updatedAt: spec.resolvedAt,
            resolvedAt: spec.resolvedAt,
          }));
          const tools: ThreadLaunchedThread[] = toolSpecs.map((spec) => ({
            id: spec.id,
            source: spec.source,
            occurredAt: spec.occurredAt,
            title: `Tool ${spec.id}`,
            prompt: "Run checks.",
            startedThread: {
              backend: spec.backend,
              threadId: spec.corruptChild ? "   " : spec.childId,
            },
            seedMode: spec.seedMode,
            groupingMode: spec.groupingMode,
            ...(spec.todoIdRef ? { todoId: spec.todoIdRef } : {}),
          }));

          const merged = mergeLaunchedThreadRecords({
            launchedTodos: todos,
            launchedThreads: tools,
          });

          // Unique ids and unique started-thread targets (unless two distinct todos targeted the same child).
          const recordIds = merged.map((record) => record.id);
          expect(new Set(recordIds).size).toBe(recordIds.length);

          // Non-decreasing canonical order by launchedAt.
          for (let index = 1; index < merged.length; index += 1) {
            expect(merged[index]!.launchedAt).toBeGreaterThanOrEqual(merged[index - 1]!.launchedAt);
          }

          // No corrupt child threadId survives.
          for (const record of merged) {
            const started = record.kind === "todo" ? record.todo.startedThread : record.launch.startedThread;
            expect(started.threadId.trim().length).toBeGreaterThan(0);
          }

          // No tool record duplicates a todo record's todoId or started thread.
          const todoIds = new Set(merged.filter((r) => r.kind === "todo").map((r) => r.id));
          const todoTargets = new Set(
            merged
              .filter((r) => r.kind === "todo")
              .map((r) => `${r.todo.startedThread.backend}:${r.todo.startedThread.threadId}`),
          );
          const toolTargets = new Set<string>();
          for (const record of merged) {
            if (record.kind === "tool") {
              if (record.launch.todoId) {
                expect(todoIds.has(record.launch.todoId)).toBe(false);
              }
              const targetKey = `${record.launch.startedThread.backend}:${record.launch.startedThread.threadId}`;
              expect(todoTargets.has(targetKey)).toBe(false);
              expect(toolTargets.has(targetKey)).toBe(false);
              toolTargets.add(targetKey);
            }
          }

          // Injecting into an empty transcript yields zero entries (preserves loading/error/empty states).
          expect(
            injectLaunchedThreads([], { launchedTodos: todos, launchedThreads: tools }, { hasPreviousPage }),
          ).toEqual([]);

          // Injecting into a populated transcript preserves original order and keeps every card standalone.
          const baseEntries: AppServerThreadEntry[] = [
            { type: "message", id: "u-1", role: "user", text: "Start", createdAt: 200 },
            { type: "activity", id: "work-1", summary: "Ran command", details: [], createdAt: 350 },
            { type: "message", id: "a-1", role: "assistant", phase: "final", text: "Done", createdAt: 800 },
          ];
          const injected = anchorTurnUsageEntries(
            injectLaunchedThreads(
              baseEntries,
              { launchedTodos: todos, launchedThreads: tools },
              { hasPreviousPage },
            ),
          );
          const originalIds = injected
            .filter((entry) => !isLaunchedTodoEntry(entry))
            .map((entry) => entry.id);
          expect(originalIds).toEqual(baseEntries.map((entry) => entry.id));

          if (hasPreviousPage) {
            for (const entry of injected) {
              if (isLaunchedTodoEntry(entry)) {
                expect(entry.createdAt).toBeGreaterThanOrEqual(200);
              }
            }
          }

          const items = buildTranscriptRenderItems({
            entries: injected,
            backend: "codex",
            now: 1_000,
          });
          // No launched-thread card is ever folded inside a work group.
          for (const item of items) {
            if (item.type === "workPhaseGroup") {
              expect(item.entries.some((entry) => isLaunchedTodoEntry(entry))).toBe(false);
            }
          }
        },
      ),
    );
  });

  it("canonicalizes tool-launch ThreadChip links across all 9 federation window frames and truthful presentation fields", () => {
    const INSTANCES = [undefined, "inst-local", "inst-peer-a", "inst-peer-b"] as const;
    fc.assert(
      fc.property(
        fc.constantFrom<string | undefined>("inst-local", undefined),
        fc.constantFrom(...INSTANCES),
        fc.constantFrom(...INSTANCES),
        fc.constantFrom(...INSTANCES),
        fc.constantFrom<"handoff_task" | "create_instance_thread">("handoff_task", "create_instance_thread"),
        fc.constantFrom<"clean" | "fork">("clean", "fork"),
        fc.option(fc.constantFrom("Environment failed", " "), { nil: undefined }),
        fc.option(fc.constantFrom("Turn busy", " "), { nil: undefined }),
        (localId, windowOwnerId, ownerInstanceId, startedInstanceId, source, seedMode, setupFailure, turnStartFailure) => {
          const launch: ThreadLaunchedThread = {
            id: "tool-launch-1",
            source,
            occurredAt: 500,
            title: "Audit retries",
            prompt: "Verify backoff ceiling.",
            projectLabel: "atlas",
            startedThread: {
              backend: "codex",
              threadId: "child-42",
              ...(startedInstanceId ? { instanceId: startedInstanceId, instanceLabel: `Host ${startedInstanceId}` } : {}),
              ...(setupFailure ? { setupFailure } : {}),
            },
            seedMode,
            groupingMode: "subthread",
            workspaceMode: "new_worktree",
            ...(turnStartFailure ? { turnStartFailure } : {}),
          };

          const presentation = buildLaunchedThreadPresentation({
            record: {
              kind: "tool",
              id: launch.id,
              launchedAt: launch.occurredAt,
              createdAt: launch.occurredAt,
              launch,
              ...(ownerInstanceId ? { ownerInstanceId } : {}),
            },
            localInstanceId: localId,
            windowOwnerInstanceId: windowOwnerId,
          });

          const effectiveOwner = startedInstanceId ?? ownerInstanceId;
          const expectedRefInstance = windowOwnerId
            ? effectiveOwner && effectiveOwner !== windowOwnerId
              ? effectiveOwner
              : undefined
            : effectiveOwner && effectiveOwner !== localId
              ? effectiveOwner
              : undefined;
          expect(presentation.linkRef.instanceId).toBe(expectedRefInstance);

          const expectedVerb = seedMode === "fork"
            ? "Forked thread"
            : source === "handoff_task"
              ? "Handed off thread"
              : "Started thread";
          expect(presentation.verb).toBe(expectedVerb);
          expect(presentation.statusChipLabel).toBe(
            setupFailure?.trim()
              ? "Setup failed"
              : turnStartFailure?.trim()
                ? "Turn failed"
                : undefined,
          );
          expect(presentation.facts).toContain("atlas");
          expect(presentation.facts).toContain("Worktree");
          expect(presentation.facts).toContain("Subthread");
        },
      ),
    );
  });
});
