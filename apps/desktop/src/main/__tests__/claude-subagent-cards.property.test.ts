import fc from "fast-check";
import type { AgentEvent, ThreadSubAgentStatus } from "@pwragent/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { ClaudeSubAgentCard } from "../claude/claude-tasks";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/**
 * Rule, from the Sub-agents panel: a Claude sub-agent's card that has ended
 * keeps its end. A report that arrives after it (a redelivered start, a
 * second notification, a late progress record) changes nothing, and the
 * panel is told about every change it should redraw, and only those.
 *
 * The model is the report stream: the first report creates the card, a
 * running card takes each later report, and the first ending is final.
 */

type Report = {
  card: number;
  status: ThreadSubAgentStatus;
  task: string;
  lastMessage?: string;
};

const TERMINAL = new Set<ThreadSubAgentStatus>(["success", "failure", "cancelled"]);

const report = fc.record<Report>({
  card: fc.nat({ max: 2 }),
  status: fc.constantFrom<ThreadSubAgentStatus>("running", "running", "success", "failure", "cancelled"),
  task: fc.constantFrom("Audit the SDK", "Audit the SDK again"),
  lastMessage: fc.option(fc.constantFrom("Done", "Stopped", "Failed"), { nil: undefined }),
}, { requiredKeys: ["card", "status", "task"] });

type ModelCard = {
  status: ThreadSubAgentStatus;
  task: string;
  lastMessage?: string;
};

const cardFor = (index: number, value: Report): ClaudeSubAgentCard => ({
  monitorId: `claude-native:agent-${index}`,
  taskId: `agent-${index}`,
  task: value.task,
  status: value.status,
  agentName: "general-purpose",
  startedAt: 1_000 + index,
  ...(value.lastMessage ? { lastMessage: value.lastMessage } : {}),
});

describe("Claude sub-agent cards", () => {
  let registry: DesktopBackendRegistry;
  let store: SqliteOverlayStore;
  const events: AgentEvent[] = [];

  beforeAll(() => {
    store = new SqliteOverlayStore(openInMemoryStateDb());
    registry = new DesktopBackendRegistry({
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

  it("ends a running card on Stop when Claude no longer runs its task", async () => {
    const record = (registry as unknown as {
      recordClaudeSubAgents(params: { threadId: string; subAgents: ClaudeSubAgentCard[] }): Promise<void>;
    }).recordClaudeSubAgents.bind(registry);
    const threadId = "claude-orphaned-card";
    const monitorId = "claude-native:agent-9";
    await record({ threadId, subAgents: [cardFor(9, { card: 9, status: "running", task: "Audit the SDK" })] });

    // No Claude session runs agent-9, so there is nothing to stop. The card
    // must not stay "running" with a Stop that always fails.
    await registry.stopSubAgent({ backend: "claude", threadId, monitorId });

    expect(await store.getThreadSubAgent({ backend: "claude", threadId, monitorId }))
      .toMatchObject({ status: "cancelled", outcome: "cancelled", lastMessage: "Stopped by user." });
  });

  it("keeps an ended card's end and notifies only real changes", async () => {
    const record = (registry as unknown as {
      recordClaudeSubAgents(params: { threadId: string; subAgents: ClaudeSubAgentCard[] }): Promise<void>;
    }).recordClaudeSubAgents.bind(registry);
    let run = 0;

    await fc.assert(fc.asyncProperty(fc.array(report, { minLength: 1, maxLength: 12 }), async (reports) => {
      const threadId = `claude-cards-${run += 1}`;
      const model = new Map<number, ModelCard>();
      // The first stored times of each card, which must never move.
      const times = new Map<number, { createdAt?: number; completedAt?: number }>();
      const notifications = () => events.filter((event) => event.notification.method === "thread/subAgents/updated"
        && (event.notification.params as { threadId: string }).threadId === threadId).length;

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

        await record({ threadId, subAgents: [cardFor(value.card, value)] });

        expect(notifications() - before).toBe(changes ? 1 : 0);
        const stored = await store.getThreadSubAgent({
          backend: "claude", threadId, monitorId: `claude-native:agent-${value.card}`,
        });
        const expected = model.get(value.card)!;
        expect(stored).toMatchObject({ status: expected.status, task: expected.task, backend: "claude" });
        expect(stored?.lastMessage).toBe(expected.lastMessage);
        const ended = TERMINAL.has(expected.status);
        expect(stored?.outcome).toBe(ended ? expected.status : undefined);
        expect(stored?.completedAt !== undefined).toBe(ended);
        // Times never move once set.
        const seen = times.get(value.card) ?? {};
        times.set(value.card, seen);
        seen.createdAt ??= stored?.createdAt;
        expect(stored?.createdAt).toBe(seen.createdAt);
        if (ended) {
          seen.completedAt ??= stored?.completedAt;
          expect(stored?.completedAt).toBe(seen.completedAt);
        }
      }
    }), { numRuns: 30 });
  });
});
