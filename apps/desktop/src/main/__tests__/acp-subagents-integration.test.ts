import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { installTestOwnerHost } from "../shell/testing/owner-host-fixture";
import fc from "fast-check";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AcpBackendId } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadSubAgentStatus } from "@pwragent/shared/contracts/navigation";
import { ACP_NATIVE_SUBAGENT_MONITOR_ID_PREFIX } from "@pwragent/shared/subagent-kind";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AcpBackendAdapter, type AcpSessionMetadata } from "../app-server/acp-backend-adapter";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import type { AcpSubAgentCard } from "../acp/acp-subagents";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const TERMINAL = new Set<ThreadSubAgentStatus>(["success", "failure", "cancelled"]);

function buildInstalledAgent(
  backendId: AcpBackendId,
  registryId: string,
): AcpInstalledAgentRecord {
  const now = Date.now();
  return {
    backendId,
    registryId,
    name: registryId,
    version: "1.0.0",
    installStatus: "installed",
    authStatus: "authenticated",
    distributionKind: "local",
    distributionSource: registryId,
    verificationStatus: "not-applicable",
    allowlistRuleId: `local-${registryId}`,
    launchDescriptor: {
      backendId,
      registryId,
      distributionKind: "local",
      command: `/opt/example/${registryId}`,
      args: [],
      env: {},
    },
    installedAt: now,
    updatedAt: now,
  };
}

describe("ACP sub-agent cards persistence & navigation projection", () => {
  let registry: DesktopBackendRegistry;
  let store: SqliteOverlayStore;
  const events: AgentEvent[] = [];

  beforeAll(async () => {
    await installTestOwnerHost();
    store = new SqliteOverlayStore(openInMemoryStateDb());
    registry = createDesktopBackendRegistry({
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [],
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
      } as never,
      overlayStore: store,
      agentToolMcpServer: null,
      pdfToolMcpServer: null,
      threadTitleGenerationService: null,
    });
    registry.onEvent((event) => { events.push(event); });
  });
  afterAll(async () => { await registry.close(); });

  it("keeps ended ACP cards immutable, classifies them into harness lens, and projects them onto thread listings", async () => {
    type Report = {
      card: number;
      status: ThreadSubAgentStatus;
      task: string;
      lastMessage?: string;
    };
    const reportArb = fc.record<Report>({
      card: fc.nat({ max: 2 }),
      status: fc.constantFrom<ThreadSubAgentStatus>("running", "running", "success", "failure", "cancelled"),
      task: fc.constantFrom("Audit PwrAgent", "Audit t3code"),
      lastMessage: fc.option(fc.constantFrom("Done", "Cancelled", "Failed"), { nil: undefined }),
    }, { requiredKeys: ["card", "status", "task"] });

    const service = registryModules(registry).subAgentMonitorService;
    const backend: AcpBackendId = "acp:antigravity";
    let run = 0;

    await fc.assert(
      fc.asyncProperty(fc.array(reportArb, { minLength: 1, maxLength: 10 }), async (reports) => {
        const threadId = `acp-cards-${run += 1}`;
        const model = new Map<number, { status: ThreadSubAgentStatus; task: string; lastMessage?: string }>();
        const times = new Map<number, { createdAt?: number; completedAt?: number }>();
        const notifications = () => events.filter((event) =>
          event.backend === backend
          && event.notification.method === "thread/subAgents/updated"
          && (event.notification.params as { threadId: string }).threadId === threadId,
        ).length;

        for (const value of reports) {
          const before = notifications();
          const previous = model.get(value.card);
          const changes = !previous || !TERMINAL.has(previous.status);
          if (changes) {
            model.set(value.card, {
              status: value.status,
              task: value.task,
              lastMessage: value.lastMessage ?? previous?.lastMessage,
            });
          }

          const card: AcpSubAgentCard = {
            monitorId: `${ACP_NATIVE_SUBAGENT_MONITOR_ID_PREFIX}agent-${value.card}`,
            subAgentId: `agent-${value.card}`,
            task: value.task,
            displayTitle: `Auditor ${value.card}`,
            agentName: `Auditor ${value.card}`,
            agentRole: "research",
            status: value.status,
            startedAt: Date.now() - 1_000,
            ...(value.lastMessage ? { lastMessage: value.lastMessage } : {}),
          };
          await service.recordAcpSubAgents({ backend, threadId, subAgents: [card] });

          expect(notifications() - before).toBe(changes ? 1 : 0);
          const stored = await store.getThreadSubAgent({
            backend,
            threadId,
            monitorId: card.monitorId,
          });
          const expected = model.get(value.card)!;
          expect(stored).toMatchObject({ status: expected.status, task: expected.task, backend });
          expect(stored?.lastMessage).toBe(expected.lastMessage);
          const ended = TERMINAL.has(expected.status);
          expect(stored?.outcome).toBe(ended ? expected.status : undefined);
          expect(stored?.completedAt !== undefined).toBe(ended);
          const seen = times.get(value.card) ?? {};
          times.set(value.card, seen);
          seen.createdAt ??= stored?.createdAt;
          expect(stored?.createdAt).toBe(seen.createdAt);
          if (ended) {
            seen.completedAt ??= stored?.completedAt;
            expect(stored?.completedAt).toBe(seen.completedAt);
          }
        }

        const counts = await store.readThreadSubAgentLensCounts({ backend, threadId, visibleSince: 0 });
        expect(counts).toEqual({ harness: model.size, pwragent: 0, "token-miser": 0 });

        const projected = await service.withAcpNativeSubAgents(backend, [{
          id: threadId,
          source: backend,
          title: "Parent thread",
          titleSource: "explicit",
          threadStatus: "idle",
          linkedDirectories: [],
        }]);
        expect(projected[0]?.codexNativeSubAgents).toHaveLength(model.size);
        for (const row of projected[0]?.codexNativeSubAgents ?? []) {
          expect(row.agentRole).toBe("research");
          expect(row.title).toMatch(/^Auditor \d$/);
        }
      }),
      { numRuns: 5 },
    );
  });

  it("records Antigravity invoke_subagent launches live and settles them when the turn finishes", async () => {
    const backendId: AcpBackendId = "acp:antigravity";
    const agent = buildInstalledAgent(backendId, "antigravity");
    let resolvePrompt!: (value: { stopReason: string }) => void;
    const transport = new FakeAcpAgentTransport({
      "session/new": { sessionId: "agy-sa-session-1" },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        transport.requests.push({ method, params, timeoutMs });
        return await new Promise((resolve) => {
          resolvePrompt = resolve as (value: { stopReason: string }) => void;
        });
      }
      return await baseRequest(method, params, timeoutMs);
    };

    const recorded: Array<{ backend: AcpBackendId; threadId: string; subAgents: AcpSubAgentCard[] }> = [];
    const recordSubAgents = vi.fn(async (params: {
      backend: AcpBackendId;
      threadId: string;
      subAgents: AcpSubAgentCard[];
    }) => {
      recorded.push(params);
    });

    const sessions = new Map<string, AcpSessionMetadata>();
    const adapter = new AcpBackendAdapter({
      captureStores: [],
      discoverLocalAcpAgents: async () => [],
      acpAgentStore: {
        getInstalledAgent: (id) => (id === backendId ? agent : undefined),
        listInstalledAgents: () => [agent],
        upsertInstalledAgent: () => {},
      },
      acpSessionStore: {
        getSession: (_backendId, sessionId) => sessions.get(sessionId),
        listSessions: () => [...sessions.values()],
        upsertSession: (metadata) => { sessions.set(metadata.sessionId, metadata); },
      },
      createAcpTransport: () => transport,
      emit: async () => {},
      handleServerRequest: async () => ({}),
      recordSubAgents,
    });

    try {
      const client = await adapter.getClient(backendId);
      const session = await client.startSession({
        cwd: "/tmp/pwragent-ag-subagent-test",
        executionMode: "default",
      });
      await client.startPrompt({
        sessionId: session.sessionId,
        prompt: "Audit four repos in parallel",
        turnId: "turn-ag-1",
      });

      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_ag_1",
        name: "invoke_subagent",
        title: "Run invoke_subagent",
        status: "in_progress",
        args: {
          Role: "PwrAgent Transcript Auditor",
          TypeName: "research",
          Prompt: "Audit PwrAgent transcript UX",
          Model: "inherit",
        },
      });
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_ag_1",
        status: "completed",
      });
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_ag_2",
        name: "invoke_subagent",
        title: "Run invoke_subagent",
        status: "in_progress",
        args: {
          Role: "t3code Transcript Auditor",
          TypeName: "research",
          Prompt: "Audit t3code transcript UX",
        },
      });
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_ag_2",
        status: "failed",
      });

      await vi.waitFor(() => {
        const latest = new Map<string, AcpSubAgentCard>();
        for (const batch of recorded) {
          for (const card of batch.subAgents) {
            latest.set(card.monitorId, card);
          }
        }
        expect(latest.get("acp-native:call_ag_1")?.status).toBe("running");
        expect(latest.get("acp-native:call_ag_2")?.status).toBe("failure");
      });

      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Finished auditing all four repos." },
      });
      resolvePrompt({ stopReason: "end_turn" });

      await vi.waitFor(() => {
        const latest = new Map<string, AcpSubAgentCard>();
        for (const batch of recorded) {
          for (const card of batch.subAgents) {
            latest.set(card.monitorId, card);
          }
        }
        expect(latest.get("acp-native:call_ag_1")).toMatchObject({
          displayTitle: "PwrAgent Transcript Auditor",
          agentRole: "research",
          status: "success",
        });
        expect(latest.get("acp-native:call_ag_2")).toMatchObject({
          displayTitle: "t3code Transcript Auditor",
          agentRole: "research",
          status: "failure",
        });
      });
    } finally {
      await adapter.close();
    }
  });

  it("records Grok protocol subagent_spawned/subagent_finished once each without writing on subagent_progress ticks", async () => {
    const backendId: AcpBackendId = "acp:grok";
    const agent = buildInstalledAgent(backendId, "grok");
    let resolvePrompt!: (value: { stopReason: string }) => void;
    const transport = new FakeAcpAgentTransport({
      "session/new": { sessionId: "grok-sa-session-1" },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        transport.requests.push({ method, params, timeoutMs });
        return await new Promise((resolve) => {
          resolvePrompt = resolve as (value: { stopReason: string }) => void;
        });
      }
      return await baseRequest(method, params, timeoutMs);
    };

    const recordSubAgents = vi.fn(async (_params: {
      backend: AcpBackendId;
      threadId: string;
      subAgents: AcpSubAgentCard[];
    }) => {});
    const sessions = new Map<string, AcpSessionMetadata>();
    const adapter = new AcpBackendAdapter({
      captureStores: [],
      discoverLocalAcpAgents: async () => [],
      acpAgentStore: {
        getInstalledAgent: (id) => (id === backendId ? agent : undefined),
        listInstalledAgents: () => [agent],
        upsertInstalledAgent: () => {},
      },
      acpSessionStore: {
        getSession: (_backendId, sessionId) => sessions.get(sessionId),
        listSessions: () => [...sessions.values()],
        upsertSession: (metadata) => { sessions.set(metadata.sessionId, metadata); },
      },
      createAcpTransport: () => transport,
      emit: async () => {},
      handleServerRequest: async () => ({}),
      recordSubAgents,
    });

    try {
      const client = await adapter.getClient(backendId);
      const session = await client.startSession({
        cwd: "/tmp/pwragent-grok-subagent-test",
        executionMode: "default",
      });
      await client.startPrompt({
        sessionId: session.sessionId,
        prompt: "Research Cloudflare",
        turnId: "turn-grok-1",
      });

      // Grok's spawn_subagent tool_call must not create a duplicate card.
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "grok-tool-1",
        title: "spawn_subagent",
        status: "in_progress",
        rawInput: { description: "Research Cloudflare" },
      });
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "subagent_spawned",
        subagent_id: "grok-sa-1",
        subagent_type: "Explore",
        description: "Research Cloudflare",
        model: "grok-4.7",
      });
      for (let i = 1; i <= 25; i += 1) {
        transport.emitSessionUpdate(session.sessionId, {
          sessionUpdate: "subagent_progress",
          subagent_id: "grok-sa-1",
          tool_calls: i,
          tokens_used: i * 500,
        });
      }
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "subagent_finished",
        subagent_id: "grok-sa-1",
        status: "completed",
        output: "Found the docs",
      });
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Finished auditing all four repos." },
      });
      resolvePrompt({ stopReason: "end_turn" });

      await vi.waitFor(() => {
        expect(recordSubAgents).toHaveBeenCalledTimes(2);
      });
      const firstBatch = recordSubAgents.mock.calls[0]?.[0];
      const secondBatch = recordSubAgents.mock.calls[1]?.[0];
      expect(firstBatch?.subAgents).toHaveLength(1);
      expect(firstBatch?.subAgents[0]).toMatchObject({
        monitorId: "acp-native:grok-sa-1",
        status: "running",
        agentRole: "Explore",
        preferredModel: "grok-4.7",
      });
      expect(secondBatch?.subAgents).toHaveLength(1);
      expect(secondBatch?.subAgents[0]).toMatchObject({
        monitorId: "acp-native:grok-sa-1",
        status: "success",
        lastMessage: "Found the docs",
      });
    } finally {
      await adapter.close();
    }
  });

  it("preserves ACP native sub-agents across cached startup thread reads (readAcpThreadsForCache)", async () => {
    const backend: AcpBackendId = "acp:antigravity";
    const threadId = "acp-cached-list-thread";
    const now = Date.now();
    await store.upsertThreadSubAgents({
      backend,
      threadId,
      subAgents: [
        {
          monitorId: `${ACP_NATIVE_SUBAGENT_MONITOR_ID_PREFIX}call_cached_1`,
          task: "Audit cached listing",
          displayTitle: "Cache Auditor",
          agentName: "Cache Auditor",
          agentRole: "research",
          status: "success",
          outcome: "success",
          backend,
          createdAt: now - 5_000,
          updatedAt: now - 1_000,
          completedAt: now - 1_000,
        },
      ],
    });
    const session = {
      backendId: backend,
      sessionId: threadId,
      agentSessionId: "ag-cached-1",
      title: "Cached ACP thread",
      titleSource: "explicit" as const,
      cwd: "/tmp/pwragent-cached-acp",
      createdAt: now - 10_000,
      updatedAt: now - 1_000,
      status: "idle" as const,
      executionMode: "default" as const,
    };
    const registryInternals = registry as unknown as {
      acpBackend: {
        listInventorySessions: () => Array<{ backendId: AcpBackendId; sessions: typeof session[] }> | undefined;
        listInstalledBackends: () => AcpBackendId[];
        listSessions: (id: AcpBackendId) => typeof session[];
        listAllSessions: () => typeof session[];
        getSession: (id: AcpBackendId, sid: string) => typeof session | undefined;
      };
      readAcpThreadsForCache: () => Promise<Array<{ id: string; codexNativeSubAgents?: Array<{ title: string; agentRole?: string }> }>>;
    };
    const origListInventory = registryInternals.acpBackend.listInventorySessions;
    const origListInstalled = registryInternals.acpBackend.listInstalledBackends;
    const origListSessions = registryInternals.acpBackend.listSessions;
    const origListAllSessions = registryInternals.acpBackend.listAllSessions;
    const origGetSession = registryInternals.acpBackend.getSession;
    registryInternals.acpBackend.listInventorySessions = () => [{ backendId: backend, sessions: [session] }];
    registryInternals.acpBackend.listInstalledBackends = () => [backend];
    registryInternals.acpBackend.listSessions = (id) => (id === backend ? [session] : []);
    registryInternals.acpBackend.listAllSessions = () => [session];
    registryInternals.acpBackend.getSession = (id, sid) => (id === backend && sid === threadId ? session : undefined);
    try {
      const cached = await registryInternals.readAcpThreadsForCache();
      const row = cached.find((item) => item.id === threadId);
      expect(row?.codexNativeSubAgents).toHaveLength(1);
      expect(row?.codexNativeSubAgents?.[0]).toMatchObject({
        title: "Cache Auditor",
        agentRole: "research",
      });
    } finally {
      registryInternals.acpBackend.listInventorySessions = origListInventory;
      registryInternals.acpBackend.listInstalledBackends = origListInstalled;
      registryInternals.acpBackend.listSessions = origListSessions;
      registryInternals.acpBackend.listAllSessions = origListAllSessions;
      registryInternals.acpBackend.getSession = origGetSession;
    }
  });
});
