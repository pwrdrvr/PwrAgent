import { registryContextStandIn } from "./helpers/registry-context-stand-in";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPullRequestStatusKey,
  type AppServerThreadMessageOrigin,
  type MessagingCausalSourceRef,
  type PrSummary,
  type ThreadDependency,
  type ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import { buildPwrAgentThreadToolRouter } from "../agent-tools/pwragent-thread-agent-tools";
import type { ForgeToolBridge } from "../app-server/forge-tool-bridge";
import type { RegistryContext } from "../app-server/registry-context";
import { ThreadDependencyCoordinator } from "../app-server/thread-dependency-coordinator";
import { ThreadInspectionTools, type ThreadInspectionToolsHost } from "../app-server/thread-inspection-tools";
import { PrStatusWatchCoordinator } from "../pr-status/pr-status-watch";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

// Rule (docs/messaging-rbac.md, thread.control.schedule): a turn that an
// agent registers for later keeps the contact that caused the registering
// turn as its source, so its tool calls are checked against that contact's
// role when it fires. The contact comes only from the calling turn's stored
// origin, never from tool arguments.
//
// Oracle: the registry's origin lookup is exact and keyed by turn id
// (`BackendRegistry.readCausalMessagingContext`); without a turn id it has
// nothing to look up. The stand-in below keeps that contract.

type Provenance = Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">;

const CALLER = "caller";
const WORKER = "worker";

const sourceArb: fc.Arbitrary<MessagingCausalSourceRef> = fc.record({
  ownerId: fc.uuid(), requestId: fc.uuid(),
  surfaceSelector: fc.constantFrom("telegram:alice", "slack:bob", "discord:carol"),
});
// A local operator's turn, a messaging contact's turn, or an ambiguous one.
const originArb: fc.Arbitrary<Provenance> = fc.oneof(
  fc.constant({}),
  sourceArb.map((causalMessagingSource) => ({ causalMessagingSource })),
  fc.constant({ causalMessagingAmbiguous: true as const }),
);

type FollowUpHandler = NonNullable<ThreadInspectionToolsHost["agentFollowUpToolHandler"]>;

/**
 * The calling turn's origin, plus a later turn on the same thread with its
 * own origin. The wake must take the calling turn's, not the thread's latest.
 */
function turnOrigins(turnId: string, origin: Provenance, otherOrigin: Provenance): Map<string, Provenance> {
  return new Map([[turnId, origin], [`${turnId}-later`, otherOrigin]]);
}

function harness(origins: Map<string, Provenance>, host: Partial<ThreadInspectionToolsHost>,
  forgeToolBridge: Partial<ForgeToolBridge> = {}) {
  const readCausalMessagingContext = async (context: { turnId?: string }): Promise<Provenance> =>
    (context.turnId ? origins.get(context.turnId) : undefined) ?? {};
  const fullHost = {
    messagingStore: null, pendingServerRequests: new Map(), isResearchWorker: () => false,
    readCausalMessagingContext, ...host,
  } as unknown as ThreadInspectionToolsHost;
  const context = {
    ...registryContextStandIn(),
    stores: { threads: { getThreadOverlayState: async () => undefined } },
    lifecycle: { closed: false },
    emit: async () => {},
  } as unknown as RegistryContext;
  const tools = new ThreadInspectionTools(context, {}, {
    forgeToolBridge: forgeToolBridge as ForgeToolBridge,
    threadInspectionSearchService: null,
  }, () => fullHost);
  return buildPwrAgentThreadToolRouter((request) => tools.handleThreadInspectionRequest(request));
}

describe("a registered wake keeps the calling turn's messaging provenance", () => {
  it("schedule_follow_up hands the handler the calling turn's origin", async () => {
    await fc.assert(fc.asyncProperty(fc.uuid(), originArb, originArb, async (turnId, origin, otherOrigin) => {
      const agentFollowUpToolHandler = vi.fn<FollowUpHandler>(async () => ({ ok: true, data: { followUps: {
        activeAgentFollowUps: 0, firedInLastDay: 0, limits: { maxActive: 8, minDelayMinutes: 1, maxFiredPerDay: 12 },
      } } }));
      const router = harness(turnOrigins(turnId, origin, otherOrigin), { agentFollowUpToolHandler });
      await router.handleMcpToolCall({ backend: "codex", threadId: CALLER, turnId, tool: "schedule_follow_up",
        args: { action: "create", delayMinutes: 5, prompt: "Check the canary and report." } });
      expect(agentFollowUpToolHandler).toHaveBeenCalledTimes(1);
      expect(agentFollowUpToolHandler.mock.calls[0]![2]).toEqual(origin);
    }));
  });

  it("watch_thread_pull_request hands the handler the calling turn's origin", async () => {
    await fc.assert(fc.asyncProperty(fc.uuid(), originArb, originArb, async (turnId, origin, otherOrigin) => {
      // Only what the handler is given matters here, not what it answers.
      const pullRequestWatchTool = vi.fn<NonNullable<ForgeToolBridge["pullRequestWatchTool"]>>(async () =>
        ({ ok: false, error: { code: "not_found", message: "No pull request in this stand-in." } }));
      const router = harness(turnOrigins(turnId, origin, otherOrigin), {}, { pullRequestWatchTool });
      await router.handleMcpToolCall({ backend: "codex", threadId: CALLER, turnId, tool: "watch_thread_pull_request",
        args: { notifyOn: ["success", "failure"] } });
      expect(pullRequestWatchTool).toHaveBeenCalledTimes(1);
      expect(pullRequestWatchTool.mock.calls[0]![1]).toEqual(origin);
    }));
  });

  it("manage_thread_dependencies stores the origin and the woken turn carries it", async () => {
    const { tempDir, dbPath } = createTempStateDb("wake-provenance-");
    const db = StateDb.open(dbPath);
    try {
      await fc.assert(fc.asyncProperty(fc.uuid(), originArb, originArb, async (turnId, origin, otherOrigin) => {
        db.raw.exec("DELETE FROM thread_dependencies");
        const store = new ThreadDependencyStore(db.raw);
        const worker = { activeTurnId: "worker-turn" as string | undefined,
          turns: [{ id: "worker-turn", status: "in_progress" as "in_progress" | "completed" }], prs: [] };
        const submit = vi.fn(async (_request: { messageOrigin?: AppServerThreadMessageOrigin }) =>
          ({ status: "started" as const, turnId: "woken" }));
        const coordinator = new ThreadDependencyCoordinator({
          store, submit, changed: async () => {}, isConsumerBusy: () => false,
          readThread: async ({ threadId }) => threadId === WORKER ? worker : { turns: [], prs: [] },
        });
        const router = harness(turnOrigins(turnId, origin, otherOrigin), {
          // As owner-services wires the coordinator to the agent tool.
          threadDependencyToolHandler: async (args, provenance, actor) => ({ ok: true, data: {
            threadDependencies: await coordinator.manage(args as never, provenance, actor),
          } }),
        });
        const result = await router.handleMcpToolCall({ backend: "codex", threadId: CALLER, turnId,
          tool: "manage_thread_dependencies", args: {
            action: "create", continuation: "Read the worker's result and summarize it.",
            conditions: [{ backend: "codex", threadId: WORKER, when: "turn_completed", title: "Worker" }],
          } });
        expect(result.isError ?? false).toBe(false);
        const [stored] = store.list("codex", CALLER);
        expect(stored).toBeDefined();
        expect({
          ...(stored!.causalMessagingSource ? { causalMessagingSource: stored!.causalMessagingSource } : {}),
          ...(stored!.causalMessagingAmbiguous ? { causalMessagingAmbiguous: true } : {}),
        }).toEqual(origin);

        worker.activeTurnId = undefined;
        worker.turns = [{ id: "worker-turn", status: "completed" }];
        await coordinator.handleThreadEvent({ backend: "codex", threadId: WORKER });
        expect(submit).toHaveBeenCalledTimes(1);
        const messageOrigin = submit.mock.calls[0]![0].messageOrigin;
        expect(messageOrigin?.causalMessagingSource).toEqual(origin.causalMessagingSource);
        expect(messageOrigin?.causalMessagingAmbiguous).toEqual(origin.causalMessagingAmbiguous);
      }), { numRuns: 25 });
    } finally {
      db.close();
      removeTempStateDbDir(tempDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Merged registrations. An identical Continue After wait is reused, and a
// second watch on the same PR and head merges into the first. One wake then
// answers several requesters, so it may carry no more authority than the
// narrowest of them: the local operator grants everything, one contact
// grants that contact's role, and a mix grants no contact's authority.
//
// Oracle: that rule, written from the requesters themselves rather than
// from `mergeCausalMessagingContext`. One profile's contacts share an
// ownerId and differ by surface.
// ---------------------------------------------------------------------------

const contactSourceArb: fc.Arbitrary<MessagingCausalSourceRef> = fc.record({
  ownerId: fc.constantFrom("profile-1", "profile-2"), requestId: fc.uuid(),
  surfaceSelector: fc.constantFrom("telegram:alice", "slack:bob"),
});
const requesterArb: fc.Arbitrary<Provenance> = fc.oneof(
  fc.constant({}),
  contactSourceArb.map((causalMessagingSource) => ({ causalMessagingSource })),
  fc.constant({ causalMessagingAmbiguous: true as const }),
);
const requestersArb = fc.array(requesterArb, { minLength: 1, maxLength: 4 });

function expectNoWiderThanEveryRequester(stored: Provenance | undefined, requesters: Provenance[]): void {
  const sources = requesters.flatMap((requester) => requester.causalMessagingSource ? [requester.causalMessagingSource] : []);
  if (requesters.every((requester) => !requester.causalMessagingSource && !requester.causalMessagingAmbiguous)) {
    expect(stored?.causalMessagingSource).toBeUndefined();
    expect(stored?.causalMessagingAmbiguous ?? false).toBe(false);
    return;
  }
  const contacts = new Set(sources.map((source) => JSON.stringify([source.ownerId, source.surfaceSelector])));
  if (sources.length === requesters.length && contacts.size === 1) {
    expect(stored?.causalMessagingAmbiguous ?? false).toBe(false);
    expect(sources).toContainEqual(stored?.causalMessagingSource);
    return;
  }
  expect(stored?.causalMessagingSource).toBeUndefined();
  expect(stored?.causalMessagingAmbiguous).toBe(true);
}

describe("a wake that answers several requesters is no wider than the narrowest", () => {
  it("an identical Continue After wait narrows to every registrant", async () => {
    const { tempDir, dbPath } = createTempStateDb("wake-provenance-merge-");
    const db = StateDb.open(dbPath);
    try {
      await fc.assert(fc.asyncProperty(requestersArb, async (requesters) => {
        db.raw.exec("DELETE FROM thread_dependencies");
        const store = new ThreadDependencyStore(db.raw);
        const worker = { activeTurnId: "worker-turn" as string | undefined,
          turns: [{ id: "worker-turn", status: "in_progress" as "in_progress" | "completed" }], prs: [] };
        const submit = vi.fn(async (_request: { messageOrigin?: AppServerThreadMessageOrigin }) =>
          ({ status: "started" as const, turnId: "woken" }));
        const coordinator = new ThreadDependencyCoordinator({
          store, submit, changed: async () => {}, isConsumerBusy: () => false,
          readThread: async ({ threadId }) => threadId === WORKER ? worker : { turns: [], prs: [] },
        });
        for (const requester of requesters) {
          await coordinator.manage({ action: "create", backend: "codex", threadId: CALLER,
            continuation: "Read the worker's result and summarize it.",
            conditions: [{ backend: "codex", threadId: WORKER, when: "turn_completed", title: "Worker" }],
          }, requester, `agent:codex:${CALLER}`);
        }
        const stored = store.list("codex", CALLER);
        expect(stored).toHaveLength(1);
        expectNoWiderThanEveryRequester(stored[0], requesters);

        worker.activeTurnId = undefined;
        worker.turns = [{ id: "worker-turn", status: "completed" }];
        await coordinator.handleThreadEvent({ backend: "codex", threadId: WORKER });
        expect(submit).toHaveBeenCalledTimes(1);
        expectNoWiderThanEveryRequester(submit.mock.calls[0]![0].messageOrigin, requesters);
      }), { numRuns: 40 });
    } finally {
      db.close();
      removeTempStateDbDir(tempDir);
    }
  });

  it("merged PR watches narrow to every requester, and so does the turn they start", async () => {
    const HEAD = "a".repeat(40);
    const pr = (overrides: Partial<PrSummary> = {}): PrSummary => ({
      provider: "github.com", number: 1105, org: "pwrdrvr", repo: "PwrAgent", title: "Keep provenance",
      state: "pending", checkState: "pending", lifecycleState: "open", reviewState: "ready_for_review",
      mergeState: "mergeable", headSha: HEAD, commitShas: [HEAD],
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1105", ...overrides,
    });
    await fc.assert(fc.asyncProperty(requestersArb, fc.constantFrom("checks", "terminal"), async (requesters, kind) => {
      const db = openInMemoryStateDb();
      try {
        const store = new SqliteOverlayStore(db);
        const now = 1_000;
        for (const [index, requester] of requesters.entries()) {
          const watch: ThreadPullRequestWatchSummary = {
            watchId: `watch-${index}`, backend: "codex", threadId: CALLER,
            prKey: buildPullRequestStatusKey(pr()), prUrl: pr().url, prNumber: 1105, headSha: HEAD,
            notifyOn: kind === "checks" ? ["success", "failure"] : ["merged", "closed"],
            createdAt: now, failureHandledByAutoFix: false, kind, createdBy: "agent",
            ...(requester.causalMessagingSource ? { causalMessagingSource: requester.causalMessagingSource } : {}),
            ...(requester.causalMessagingAmbiguous ? { causalMessagingAmbiguous: true } : {}),
          };
          await store.registerThreadPrStatusWatch({ watch, now });
        }
        const active = await store.listActiveThreadPrStatusWatches({ backend: "codex", threadId: CALLER });
        expect(active).toHaveLength(1);
        expectNoWiderThanEveryRequester(active[0], requesters);

        const submitTurnIfIdle = vi.fn(async (_request: { messageOrigin: AppServerThreadMessageOrigin }) =>
          ({ status: "started" as const, turnId: "woken" }));
        const coordinator = new PrStatusWatchCoordinator({
          store, registry: { submitTurnIfIdle }, now: () => now, fetchTerminalDetails: async () => undefined,
        });
        await coordinator.handleStatusSnapshot(kind === "checks"
          ? pr({ state: "passing", checkState: "passing" })
          : pr({ state: "passing", checkState: "passing", lifecycleState: "merged", mergedAt: now }), now);
        expect(submitTurnIfIdle).toHaveBeenCalledTimes(1);
        expectNoWiderThanEveryRequester(submitTurnIfIdle.mock.calls[0]![0].messageOrigin, requesters);
      } finally {
        db.close();
      }
    }), { numRuns: 40 });
  });
});

describe("narrowing a reused wait", () => {
  it("costs one commit when a new requester narrows it, and none when it is already that narrow", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { tempDir, dbPath } = createTempStateDb("wake-provenance-budget-");
    const db = StateDb.open(dbPath);
    try {
      const store = new ThreadDependencyStore(db.raw);
      const wait = (id: string, provenance: Provenance): ThreadDependency => ({
        id, backend: "codex", threadId: CALLER, mode: "all", onFailure: "notify",
        conditions: [{ backend: "codex", threadId: WORKER, when: "turn_completed", turnId: "worker-turn" }],
        continuation: "Read the worker's result and summarize it.", status: "waiting", evidence: [],
        createdAt: 1, updatedAt: 1, ...provenance,
      });
      store.register(wait("operator", {}));
      const contact = { causalMessagingSource: { ownerId: "profile-1", requestId: "request-1", surfaceSelector: "telegram:alice" } };
      const narrowed = await measureSqliteWrites(() => store.register(wait("contact", contact)));
      expect(narrowed.result).toMatchObject({ id: "operator", causalMessagingAmbiguous: true });
      expectSqliteWriteBudget({
        scenario: "thread-dependencies-duplicate-narrowing", writes: narrowed.writes,
        note: "A different requester re-registers an identical Continue After wait: one commit per such create, and 0 MB/day at any realistic rate.",
      });
      const unchanged = await measureSqliteWrites(() => store.register(wait("again", { causalMessagingAmbiguous: true })));
      expect(unchanged.result.id).toBe("operator");
      expectSqliteWriteBudget({
        scenario: "thread-dependencies-duplicate-reuse", writes: unchanged.writes,
        note: "An identical Continue After wait whose requester changes nothing is reused without a write.",
      });
    } finally {
      db.close();
      removeTempStateDbDir(tempDir);
    }
  });
});
