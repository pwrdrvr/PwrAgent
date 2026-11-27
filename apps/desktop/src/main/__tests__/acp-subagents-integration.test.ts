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
import { AcpSubAgentTracker, type AcpSubAgentCard } from "../acp/acp-subagents";
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
      await vi.waitFor(() => {
        expect(recordSubAgents).toHaveBeenCalledTimes(1);
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

  it("settles running protocol sub-agents on prompt failure, cancel, and adapter close", async () => {
    const backendId: AcpBackendId = "acp:grok";
    const agent = buildInstalledAgent(backendId, "grok");
    const promptResolvers: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const transport = new FakeAcpAgentTransport({
      "session/new": { sessionId: "grok-lifecycle-session" },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        transport.requests.push({ method, params, timeoutMs });
        return await new Promise((resolve, reject) => {
          promptResolvers.push({ resolve, reject });
        });
      }
      return await baseRequest(method, params, timeoutMs);
    };

    const recorded: AcpSubAgentCard[] = [];
    const recordSubAgents = vi.fn(async (params: {
      backend: AcpBackendId;
      threadId: string;
      subAgents: AcpSubAgentCard[];
    }) => {
      recorded.push(...params.subAgents);
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

    const latestById = () => {
      const map = new Map<string, AcpSubAgentCard>();
      for (const card of recorded) map.set(card.monitorId, card);
      return map;
    };

    try {
      const client = await adapter.getClient(backendId);
      const session = await client.startSession({ cwd: "/tmp/grok-lifecycle", executionMode: "default" });

      // 1. Prompt error settles running protocol sub-agent as failure.
      await client.startPrompt({ sessionId: session.sessionId, prompt: "Turn 1", turnId: "t1" });
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "subagent_spawned",
        subagent_id: "grok-err-1",
        description: "Check error settlement",
      });
      await vi.waitFor(() => expect(latestById().get("acp-native:grok-err-1")?.status).toBe("running"));
      promptResolvers.shift()!.reject(new Error("Upstream disconnect"));
      await vi.waitFor(() => expect(latestById().get("acp-native:grok-err-1")?.status).toBe("failure"));

      // 2. Cancelled turn settles running protocol sub-agent as cancelled.
      await client.startPrompt({ sessionId: session.sessionId, prompt: "Turn 2", turnId: "t2" });
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "subagent_spawned",
        subagent_id: "grok-cancel-1",
        description: "Check cancel settlement",
      });
      await vi.waitFor(() => expect(latestById().get("acp-native:grok-cancel-1")?.status).toBe("running"));
      promptResolvers.shift()!.resolve({ stopReason: "cancelled" });
      await vi.waitFor(() => expect(latestById().get("acp-native:grok-cancel-1")?.status).toBe("cancelled"));

      // 3. Adapter close settles still-running sub-agent and awaits flush before resolving.
      await client.startPrompt({ sessionId: session.sessionId, prompt: "Turn 3", turnId: "t3" });
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "subagent_spawned",
        subagent_id: "grok-close-1",
        description: "Check close settlement",
      });
      await vi.waitFor(() => expect(latestById().get("acp-native:grok-close-1")?.status).toBe("running"));
    } finally {
      await adapter.close();
    }
    expect(latestById().get("acp-native:grok-close-1")?.status).toBe("cancelled");
  });

  it("settles a prior turn's running invoke_subagent immediately when the next turn dispatches", async () => {
    const backendId: AcpBackendId = "acp:antigravity";
    const agent = buildInstalledAgent(backendId, "antigravity");
    const promptResolvers: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const transport = new FakeAcpAgentTransport({
      "session/new": { sessionId: "agy-next-turn-session" },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        transport.requests.push({ method, params, timeoutMs });
        return await new Promise((resolve, reject) => {
          promptResolvers.push({ resolve, reject });
        });
      }
      return await baseRequest(method, params, timeoutMs);
    };

    const recorded: AcpSubAgentCard[] = [];
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
      recordSubAgents: async ({ subAgents }) => { recorded.push(...subAgents); },
    });

    try {
      const client = await adapter.getClient(backendId);
      const session = await client.startSession({ cwd: "/tmp/ag-next-turn", executionMode: "default" });
      // An un-settled invoke_subagent from a prior turn that missed turn_finished
      // (session is idle again, so the next prompt can dispatch).
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_prior_turn",
        name: "invoke_subagent",
        status: "in_progress",
        args: { Role: "Prior Auditor", TypeName: "research", Prompt: "Audit" },
      });
      await vi.waitFor(() =>
        expect(recorded.at(-1)).toMatchObject({ monitorId: "acp-native:call_prior_turn", status: "running" }),
      );

      // Turn 2 dispatches and fails immediately before emitting any update.
      // `onTurnStarted` must settle the prior worker immediately on dispatch.
      await client.startPrompt({ sessionId: session.sessionId, prompt: "Turn 2", turnId: "t2" });
      promptResolvers[0]!.reject(new Error("Immediate rejection before update"));

      await vi.waitFor(() => {
        const latest = [...recorded].reverse().find((c) => c.monitorId === "acp-native:call_prior_turn");
        expect(latest?.status).toBe("success");
      });
    } finally {
      await adapter.close();
    }
  });

  it("flushes only dirty cards in O(k), retries failed flushes via markDirty, and skips tracker allocation for ordinary tool calls", async () => {
    let cardsBuiltInFlushes = 0;
    const origSubAgentCards = AcpSubAgentTracker.prototype.subAgentCards;
    const origDirtyCards = AcpSubAgentTracker.prototype.takeDirtySubAgentCards;
    const allSpy = vi.spyOn(AcpSubAgentTracker.prototype, "subAgentCards").mockImplementation(function (this: AcpSubAgentTracker) {
      const cards = origSubAgentCards.call(this);
      cardsBuiltInFlushes += cards.length;
      return cards;
    });
    const dirtySpy = vi.spyOn(AcpSubAgentTracker.prototype, "takeDirtySubAgentCards").mockImplementation(function (this: AcpSubAgentTracker) {
      const cards = origDirtyCards.call(this);
      cardsBuiltInFlushes += cards.length;
      return cards;
    });

    let failOnce = true;
    const persisted: AcpSubAgentCard[] = [];
    const adapter = new AcpBackendAdapter({
      captureStores: [],
      discoverLocalAcpAgents: async () => [],
      emit: async () => {},
      handleServerRequest: async () => ({}),
      recordSubAgents: async ({ subAgents }) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transient sqlite busy");
        }
        persisted.push(...subAgents);
      },
    });
    const internal = adapter as unknown as {
      observeAcpSubAgentUpdate: (p: Record<string, unknown>) => void;
      settleAcpSessionSubAgents: (p: Record<string, unknown>) => void;
      drainAcpSessionSubAgentFlush: (s: unknown) => void;
      subAgentSessions: Map<string, { flushChain: Promise<void> }>;
    };

    try {
      // 50 ordinary sessions that run read_file must allocate 0 tracker entries.
      for (let i = 0; i < 50; i += 1) {
        internal.observeAcpSubAgentUpdate({
          backend: "acp:antigravity",
          sessionId: `ord-${i}`,
          turnId: "t1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `read-${i}`,
            name: "read_file",
            status: "completed",
          },
        });
      }
      expect(internal.subAgentSessions.size).toBe(0);

      // 20 sequential sub-agent turns on one session: launch + flush + settle.
      // First flush throws once; settling the same worker retries and persists it.
      for (let i = 0; i < 20; i += 1) {
        const turnId = `turn-${i}`;
        internal.observeAcpSubAgentUpdate({
          backend: "acp:antigravity",
          sessionId: "subagent-sess",
          turnId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `call-${i}`,
            title: "Run invoke_subagent",
            status: "in_progress",
            rawInput: { Role: `Worker ${i}`, TypeName: "research", Prompt: `Task ${i}` },
          },
        });
        const state = internal.subAgentSessions.get("acp:antigravity:subagent-sess")!;
        internal.drainAcpSessionSubAgentFlush(state);
        await state.flushChain;
        internal.settleAcpSessionSubAgents({
          backend: "acp:antigravity",
          sessionId: "subagent-sess",
          turnId,
          outcome: "completed",
        });
        await state.flushChain;
      }

      // Linear O(N): 20 launches + 20 settlements = 40 dirty cards built
      // (previously O(N²): 20 * 21 = 420 cards rebuilt and JSON-stringified).
      expect(allSpy).not.toHaveBeenCalled();
      expect(cardsBuiltInFlushes).toBe(40);
      expect(persisted.filter((c) => c.monitorId === "acp-native:call-0").at(-1)?.status).toBe("success");
      expect(persisted.filter((c) => c.monitorId === "acp-native:call-19").at(-1)?.status).toBe("success");
    } finally {
      allSpy.mockRestore();
      dirtySpy.mockRestore();
      await adapter.close();
    }
  });

  it("drains a pending 25ms coalescing timer immediately on terminal turn settlement even when settleTurn changes nothing", async () => {
    const persisted: AcpSubAgentCard[] = [];
    const adapter = new AcpBackendAdapter({
      captureStores: [],
      discoverLocalAcpAgents: async () => [],
      emit: async () => {},
      handleServerRequest: async () => ({}),
      recordSubAgents: async ({ subAgents }) => {
        persisted.push(...subAgents);
      },
    });
    const internal = adapter as unknown as {
      observeAcpSubAgentUpdate: (p: Record<string, unknown>) => void;
      settleAcpSessionSubAgents: (p: Record<string, unknown>) => void;
      subAgentSessions: Map<string, { flushTimer?: ReturnType<typeof setTimeout>; flushChain: Promise<void> }>;
    };

    try {
      // Case 1: Grok subagent_finished schedules the 25ms timer; turn_finished arrives
      // immediately afterward within the window. settleTurn returns false, yet the timer
      // must drain synchronously so callers observing turn completion see the settled card.
      internal.observeAcpSubAgentUpdate({
        backend: "acp:grok",
        sessionId: "grok-drain-1",
        turnId: "turn-1",
        update: {
          sessionUpdate: "subagent_finished",
          subagent_id: "sub-1",
          description: "Quick worker",
          status: "completed",
        },
      });
      const state1 = internal.subAgentSessions.get("acp:grok:grok-drain-1")!;
      expect(state1.flushTimer).toBeDefined();
      internal.observeAcpSubAgentUpdate({
        backend: "acp:grok",
        sessionId: "grok-drain-1",
        turnId: "turn-1",
        update: { sessionUpdate: "turn_finished" },
        turnSettledOutcome: "completed",
      });
      expect(state1.flushTimer).toBeUndefined();
      await state1.flushChain;
      expect(persisted.find((c) => c.monitorId === "acp-native:sub-1")?.status).toBe("success");

      // Case 2: Failed Antigravity launch schedules the 25ms timer; onPromptError calls
      // settleAcpSessionSubAgents immediately afterward before the timer fires.
      internal.observeAcpSubAgentUpdate({
        backend: "acp:antigravity",
        sessionId: "agy-drain-2",
        turnId: "turn-2",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-fail-2",
          title: "Run invoke_subagent",
          status: "failed",
          rawInput: { Role: "Failed Worker", TypeName: "research", Prompt: "Audit" },
        },
      });
      const state2 = internal.subAgentSessions.get("acp:antigravity:agy-drain-2")!;
      expect(state2.flushTimer).toBeDefined();
      internal.settleAcpSessionSubAgents({
        backend: "acp:antigravity",
        sessionId: "agy-drain-2",
        turnId: "turn-2",
        outcome: "failed",
      });
      expect(state2.flushTimer).toBeUndefined();
      await state2.flushChain;
      expect(persisted.find((c) => c.monitorId === "acp-native:call-fail-2")?.status).toBe("failure");
    } finally {
      await adapter.close();
    }
  });

  it("schedules a bounded retry when a terminal sub-agent flush fails on an idle session", async () => {
    let attempts = 0;
    const persisted: AcpSubAgentCard[] = [];
    const adapter = new AcpBackendAdapter({
      captureStores: [],
      discoverLocalAcpAgents: async () => [],
      emit: async () => {},
      handleServerRequest: async () => ({}),
      recordSubAgents: async ({ subAgents }) => {
        attempts += 1;
        if (attempts === 2) {
          throw new Error("transient sqlite busy on terminal flush");
        }
        persisted.push(...subAgents);
      },
    });
    const internal = adapter as unknown as {
      observeAcpSubAgentUpdate: (p: Record<string, unknown>) => void;
      settleAcpSessionSubAgents: (p: Record<string, unknown>) => void;
      drainAcpSessionSubAgentFlush: (s: unknown) => void;
      subAgentSessions: Map<string, { flushTimer?: ReturnType<typeof setTimeout>; flushChain: Promise<void> }>;
    };

    try {
      internal.observeAcpSubAgentUpdate({
        backend: "acp:antigravity",
        sessionId: "retry-terminal-sess",
        turnId: "turn-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-retry-1",
          title: "Run invoke_subagent",
          status: "in_progress",
          rawInput: { Role: "Terminal Retry Worker", TypeName: "research", Prompt: "Audit" },
        },
      });
      const state = internal.subAgentSessions.get("acp:antigravity:retry-terminal-sess")!;
      internal.drainAcpSessionSubAgentFlush(state);
      await state.flushChain;
      expect(persisted.at(-1)?.status).toBe("running");

      // Terminal flush fails transiently; session is now idle with no further updates.
      internal.settleAcpSessionSubAgents({
        backend: "acp:antigravity",
        sessionId: "retry-terminal-sess",
        turnId: "turn-1",
        outcome: "completed",
      });
      await state.flushChain;
      expect(persisted.at(-1)?.status).toBe("running");

      // Bounded backoff retry persists the terminal card automatically.
      await vi.waitFor(() => {
        expect(persisted.filter((c) => c.monitorId === "acp-native:call-retry-1").at(-1)?.status).toBe("success");
      }, { timeout: 1_000 });
      expect(attempts).toBe(3);
    } finally {
      await adapter.close();
    }
  });

  it("repairs orphaned running acp-native sub-agent cards during startup reconciliation", async () => {
    const stateDb = openInMemoryStateDb();
    try {
      const store = new SqliteOverlayStore(stateDb);
      const startedAt = Date.now() - 120_000;
      await store.upsertThreadSubAgents({
        backend: "acp:antigravity",
        threadId: "crashed-acp-session",
        subAgents: [
          {
            monitorId: "acp-native:orphaned-worker-1",
            task: "Audit after crash",
            displayTitle: "Orphaned Worker",
            status: "running",
            createdAt: startedAt,
            updatedAt: startedAt + 1_000,
            ownerRuntimeInstanceId: "dead-runtime-instance",
            ownerRegistrySessionId: "dead-registry-session",
            backend: "acp:antigravity",
          },
        ],
      });

      const repair = await store.reconcileOrphanedThreadSubAgents({
        currentRuntimeInstanceId: "live-runtime-instance",
        currentRegistrySessionId: "live-registry-session",
        liveRuntimeInstanceIds: ["live-runtime-instance"],
        sessionStartedAt: Date.now(),
      });

      expect(repair.repairedSubAgents).toBe(1);
      expect(repair.repairedThreads).toBe(1);
      const [repaired] = await store.listThreadSubAgents({
        backend: "acp:antigravity",
        threadId: "crashed-acp-session",
      });
      expect(repaired?.status).toBe("failure");
      expect(repaired?.outcome).toBe("failure");
      expect(repaired?.completedAt).toBe(startedAt + 1_000);
      expect(repaired?.completionSource).toMatchObject({
        type: "pwragent_fallback",
        reason: "owner_runtime_stopped",
      });
    } finally {
      stateDb.close();
    }
  });
});
