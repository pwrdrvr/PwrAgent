import { registryContextStandIn } from "./helpers/registry-context-stand-in";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadMessageOrigin, MessagingCausalSourceRef } from "@pwragent/shared";
import { buildPwrAgentThreadToolRouter } from "../agent-tools/pwragent-thread-agent-tools";
import type { ForgeToolBridge } from "../app-server/forge-tool-bridge";
import type { RegistryContext } from "../app-server/registry-context";
import { ThreadDependencyCoordinator } from "../app-server/thread-dependency-coordinator";
import { ThreadInspectionTools, type ThreadInspectionToolsHost } from "../app-server/thread-inspection-tools";
import { StateDb } from "../state/state-db";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

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

function harness(origins: Map<string, Provenance>, host: Partial<ThreadInspectionToolsHost>) {
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
    forgeToolBridge: {} as ForgeToolBridge,
    threadInspectionSearchService: null,
  }, () => fullHost);
  return buildPwrAgentThreadToolRouter((request) => tools.handleThreadInspectionRequest(request));
}

describe("a registered wake keeps the calling turn's messaging provenance", () => {
  it("schedule_follow_up hands the handler the calling turn's origin", async () => {
    await fc.assert(fc.asyncProperty(fc.uuid(), originArb, async (turnId, origin) => {
      const agentFollowUpToolHandler = vi.fn(async (_args: unknown, _thread: unknown, _provenance?: Provenance) =>
        ({ ok: true as const, data: {} }));
      const router = harness(new Map([[turnId, origin]]), { agentFollowUpToolHandler } as never);
      await router.handleMcpToolCall({ backend: "codex", threadId: CALLER, turnId, tool: "schedule_follow_up",
        args: { action: "create", delayMinutes: 5, prompt: "Check the canary and report." } });
      expect(agentFollowUpToolHandler).toHaveBeenCalledTimes(1);
      expect(agentFollowUpToolHandler.mock.calls[0]![2]).toEqual(origin);
    }));
  });

  it("manage_thread_dependencies stores the origin and the woken turn carries it", async () => {
    const { tempDir, dbPath } = createTempStateDb("wake-provenance-");
    const db = StateDb.open(dbPath);
    try {
      await fc.assert(fc.asyncProperty(fc.uuid(), originArb, async (turnId, origin) => {
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
        const router = harness(new Map([[turnId, origin]]), {
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
