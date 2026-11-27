import fc from "fast-check";
import type { ThreadSubAgentStatus } from "@pwragent/shared/contracts/navigation";
import { ACP_NATIVE_SUBAGENT_MONITOR_ID_PREFIX } from "@pwragent/shared/subagent-kind";
import { describe, expect, it, vi } from "vitest";
import {
  AcpSubAgentTracker,
  formatAcpInvokeSubAgentLabel,
  readAcpInvokeSubAgentDetails,
} from "../acp/acp-subagents";
import { AcpSessionReplayNormalizer } from "../acp/acp-session-normalizer";

const TERMINAL = new Set<ThreadSubAgentStatus>(["success", "failure", "cancelled"]);

type TrackerEvent =
  | { kind: "invoke_start"; id: string; turnId: string; role?: string; typeName?: string; prompt?: string; model?: string }
  | { kind: "invoke_update"; id: string; turnId: string; status: "in_progress" | "completed" | "failed" | "cancelled"; role?: string; conversationId?: string }
  | { kind: "protocol_spawn"; id: string; description?: string; subagentType?: string; model?: string }
  | { kind: "protocol_progress"; id: string; toolCalls: number; tokens: number }
  | { kind: "protocol_finish"; id: string; status: "completed" | "cancelled" | "failed" | "error"; output?: string; error?: string }
  | { kind: "grok_spawn_tool"; id: string; description: string }
  | { kind: "manage_kill_all"; status: "in_progress" | "completed" }
  | { kind: "manage_kill"; ids: string[]; status: "in_progress" | "completed" }
  | { kind: "turn_started"; turnId: string }
  | { kind: "turn_settled"; turnId: string; outcome: "completed" | "failed" | "cancelled" }
  | { kind: "session_end"; status: "cancelled" | "failure" };

const agentIdArb = fc.constantFrom("a1", "a2", "a3", "a4");
const turnIdArb = fc.constantFrom("turn-1", "turn-2", "turn-3");
const roleArb = fc.option(fc.constantFrom("PwrAgent Auditor", "t3code Auditor", "Diff Checker"), { nil: undefined });
const typeNameArb = fc.option(fc.constantFrom("research", "self", "general-purpose", "Explore"), { nil: undefined });
const promptArb = fc.option(fc.constantFrom("Audit transcript UX", "Check parser scaling"), { nil: undefined });
const modelArb = fc.option(fc.constantFrom("inherit", "grok-4.7", "gemini-4-neon"), { nil: undefined });

const trackerEventArb: fc.Arbitrary<TrackerEvent> = fc.oneof(
  fc.record({
    kind: fc.constant("invoke_start" as const),
    id: agentIdArb,
    turnId: turnIdArb,
    role: roleArb,
    typeName: typeNameArb,
    prompt: promptArb,
    model: modelArb,
  }),
  fc.record({
    kind: fc.constant("invoke_update" as const),
    id: agentIdArb,
    turnId: turnIdArb,
    status: fc.constantFrom<"in_progress" | "completed" | "failed" | "cancelled">("in_progress", "completed", "completed", "failed", "cancelled"),
    role: roleArb,
    conversationId: fc.option(fc.constantFrom("conv-11111111", "conv-22222222"), { nil: undefined }),
  }),
  fc.record({
    kind: fc.constant("protocol_spawn" as const),
    id: agentIdArb,
    description: fc.option(fc.constantFrom("[reviewer] pr #1644", "Research Cloudflare"), { nil: undefined }),
    subagentType: typeNameArb,
    model: fc.option(fc.constantFrom("grok-4.7", "grok-4.6"), { nil: undefined }),
  }),
  fc.record({
    kind: fc.constant("protocol_progress" as const),
    id: agentIdArb,
    toolCalls: fc.nat({ max: 50 }),
    tokens: fc.nat({ max: 50_000 }),
  }),
  fc.record({
    kind: fc.constant("protocol_finish" as const),
    id: agentIdArb,
    status: fc.constantFrom<"completed" | "cancelled" | "failed" | "error">("completed", "cancelled", "failed", "error"),
    output: fc.option(fc.constantFrom("Done auditing.", "Summary ready."), { nil: undefined }),
    error: fc.option(fc.constantFrom("Subagent was cancelled", "Timeout"), { nil: undefined }),
  }),
  fc.record({
    kind: fc.constant("grok_spawn_tool" as const),
    id: agentIdArb,
    description: fc.constantFrom("Research Vercel", "Check PR"),
  }),
  fc.record({
    kind: fc.constant("manage_kill_all" as const),
    status: fc.constantFrom<"in_progress" | "completed">("in_progress", "completed"),
  }),
  fc.record({
    kind: fc.constant("manage_kill" as const),
    ids: fc.subarray(["conv-11111111", "conv-22222222", "a1", "unknown-id"], { minLength: 1 }),
    status: fc.constantFrom<"in_progress" | "completed">("in_progress", "completed"),
  }),
  fc.record({
    kind: fc.constant("turn_started" as const),
    turnId: turnIdArb,
  }),
  fc.record({
    kind: fc.constant("turn_settled" as const),
    turnId: turnIdArb,
    outcome: fc.constantFrom<"completed" | "failed" | "cancelled">("completed", "failed", "cancelled"),
  }),
  fc.record({
    kind: fc.constant("session_end" as const),
    status: fc.constantFrom<"cancelled" | "failure">("cancelled", "failure"),
  }),
);

type ReferenceAgent = {
  id: string;
  turnId?: string;
  settlesWithTurn: boolean;
  conversationId?: string;
  status: ThreadSubAgentStatus;
  startedAt: number;
  completedAt?: number;
  lastMessage?: string;
};

describe("AcpSubAgentTracker model-based tests", () => {
  it("preserves terminal finality, zero-write progress, and turn-bound settlement across arbitrary event streams", () => {
    fc.assert(
      fc.property(fc.array(trackerEventArb, { minLength: 1, maxLength: 35 }), (events) => {
        let clock = 10_000;
        const tracker = new AcpSubAgentTracker(() => (clock += 10));
        const ref = new Map<string, ReferenceAgent>();
        const convToId = new Map<string, string>();

        const settleRef = (agent: ReferenceAgent, status: ThreadSubAgentStatus, ts: number, lastMessage?: string) => {
          agent.status = status;
          agent.completedAt = Math.max(ts, agent.startedAt);
          if (lastMessage) agent.lastMessage = lastMessage;
        };

        for (const ev of events) {
          const ts = (clock += 10);
          let changed: boolean;

          if (ev.kind === "invoke_start") {
            changed = tracker.apply({
              backendId: "acp:antigravity",
              turnId: ev.turnId,
              receivedAt: ts,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: ev.id,
                name: "invoke_subagent",
                status: "in_progress",
                title: "Run invoke_subagent",
                args: {
                  ...(ev.role ? { Role: ev.role } : {}),
                  ...(ev.typeName ? { TypeName: ev.typeName } : {}),
                  ...(ev.prompt ? { Prompt: ev.prompt } : {}),
                  ...(ev.model ? { Model: ev.model } : {}),
                },
              },
            });
            if (!ref.has(ev.id)) {
              ref.set(ev.id, {
                id: ev.id,
                turnId: ev.turnId,
                settlesWithTurn: true,
                status: "running",
                startedAt: ts,
              });
            }
          } else if (ev.kind === "invoke_update") {
            changed = tracker.apply({
              backendId: "acp:antigravity",
              turnId: ev.turnId,
              receivedAt: ts,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: ev.id,
                name: "invoke_subagent",
                status: ev.status,
                title: "Run invoke_subagent",
                args: ev.role ? { Role: ev.role } : {},
                ...(ev.conversationId ? { rawOutput: { conversationId: ev.conversationId } } : {}),
              },
            });
            let agent = ref.get(ev.id);
            if (!agent) {
              agent = {
                id: ev.id,
                turnId: ev.turnId,
                settlesWithTurn: true,
                status: "running",
                startedAt: ts,
              };
              ref.set(ev.id, agent);
            }
            if (!TERMINAL.has(agent.status)) {
              if (ev.conversationId && !agent.conversationId) {
                agent.conversationId = ev.conversationId;
                convToId.set(ev.conversationId, ev.id);
              }
              if (ev.status === "failed") {
                settleRef(agent, "failure", ts);
              } else if (ev.status === "cancelled") {
                settleRef(agent, "cancelled", ts);
              }
            }
          } else if (ev.kind === "protocol_spawn") {
            changed = tracker.apply({
              backendId: "acp:grok",
              receivedAt: ts,
              update: {
                sessionUpdate: "subagent_spawned",
                subagent_id: ev.id,
                child_session_id: ev.id,
                ...(ev.description ? { description: ev.description } : {}),
                ...(ev.subagentType ? { subagent_type: ev.subagentType } : {}),
                ...(ev.model ? { model: ev.model } : {}),
              },
            });
            const mapped = convToId.get(ev.id) ?? ev.id;
            const existing = ref.get(mapped);
            if (!existing) {
              ref.set(mapped, {
                id: mapped,
                conversationId: ev.id,
                settlesWithTurn: false,
                status: "running",
                startedAt: ts,
              });
              convToId.set(ev.id, mapped);
            } else if (!TERMINAL.has(existing.status)) {
              existing.settlesWithTurn = false;
            }
          } else if (ev.kind === "protocol_progress") {
            const beforeCards = JSON.stringify(tracker.subAgentCards());
            changed = tracker.apply({
              backendId: "acp:grok",
              receivedAt: ts,
              update: {
                sessionUpdate: "subagent_progress",
                subagent_id: ev.id,
                tool_call_count: ev.toolCalls,
                tokens_used: ev.tokens,
              },
            });
            // Progress must NEVER mutate cards or report a persistence change.
            expect(changed).toBe(false);
            expect(JSON.stringify(tracker.subAgentCards())).toBe(beforeCards);
          } else if (ev.kind === "protocol_finish") {
            changed = tracker.apply({
              backendId: "acp:grok",
              receivedAt: ts,
              update: {
                sessionUpdate: "subagent_finished",
                subagent_id: ev.id,
                status: ev.status,
                ...(ev.output ? { output: ev.output } : {}),
                ...(ev.error ? { error: ev.error } : {}),
              },
            });
            const mapped = convToId.get(ev.id) ?? ev.id;
            let agent = ref.get(mapped);
            if (!agent) {
              agent = {
                id: mapped,
                conversationId: ev.id,
                settlesWithTurn: false,
                status: "running",
                startedAt: ts,
              };
              ref.set(mapped, agent);
              convToId.set(ev.id, mapped);
            }
            if (!TERMINAL.has(agent.status)) {
              const status: ThreadSubAgentStatus =
                ev.status === "completed" ? "success" : ev.status === "cancelled" ? "cancelled" : "failure";
              settleRef(agent, status, ts, ev.error ?? ev.output);
            }
          } else if (ev.kind === "grok_spawn_tool") {
            const beforeCards = JSON.stringify(tracker.subAgentCards());
            changed = tracker.apply({
              backendId: "acp:grok",
              receivedAt: ts,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: `call-${ev.id}`,
                title: "spawn_subagent",
                rawInput: { description: ev.description },
              },
            });
            expect(changed).toBe(false);
            expect(JSON.stringify(tracker.subAgentCards())).toBe(beforeCards);
          } else if (ev.kind === "manage_kill_all") {
            changed = tracker.apply({
              backendId: "acp:antigravity",
              receivedAt: ts,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "manage-all",
                name: "manage_subagents",
                status: ev.status,
                args: { Action: "kill_all" },
              },
            });
            if (ev.status === "completed") {
              for (const agent of ref.values()) {
                if (!TERMINAL.has(agent.status) && agent.settlesWithTurn) {
                  settleRef(agent, "cancelled", ts, "Stopped by parent agent.");
                }
              }
            }
          } else if (ev.kind === "manage_kill") {
            changed = tracker.apply({
              backendId: "acp:antigravity",
              receivedAt: ts,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "manage-one",
                name: "manage_subagents",
                status: ev.status,
                args: { Action: "kill", ConversationIds: ev.ids },
              },
            });
            if (ev.status === "completed") {
              for (const raw of ev.ids) {
                const target = convToId.get(raw) ?? raw;
                const agent = ref.get(target);
                if (agent && !TERMINAL.has(agent.status)) {
                  settleRef(agent, "cancelled", ts, "Stopped by parent agent.");
                }
              }
            }
          } else if (ev.kind === "turn_started") {
            changed = tracker.onTurnStarted(ev.turnId, ts);
            for (const agent of ref.values()) {
              if (!TERMINAL.has(agent.status) && agent.settlesWithTurn && agent.turnId !== ev.turnId) {
                settleRef(agent, "success", ts);
              }
            }
          } else if (ev.kind === "turn_settled") {
            changed = tracker.settleTurn({ turnId: ev.turnId, outcome: ev.outcome, at: ts });
            const status: ThreadSubAgentStatus =
              ev.outcome === "completed" ? "success" : ev.outcome === "cancelled" ? "cancelled" : "failure";
            for (const agent of ref.values()) {
              if (TERMINAL.has(agent.status)) {
                continue;
              }
              if (
                ev.outcome !== "completed"
                || (agent.settlesWithTurn && (!agent.turnId || agent.turnId === ev.turnId))
              ) {
                settleRef(agent, status, ts);
              }
            }
          } else {
            changed = tracker.endRunningSubAgents(ev.status, ts);
            for (const agent of ref.values()) {
              if (!TERMINAL.has(agent.status)) {
                settleRef(agent, ev.status, ts);
              }
            }
          }

          // Check invariants after EVERY step.
          const cards = tracker.subAgentCards();
          expect(cards).toHaveLength(ref.size);
          const ids = new Set(cards.map((card) => card.monitorId));
          expect(ids.size).toBe(cards.length);
          let expectedActive = 0;
          for (const card of cards) {
            expect(card.monitorId.startsWith(ACP_NATIVE_SUBAGENT_MONITOR_ID_PREFIX)).toBe(true);
            const expected = ref.get(card.subAgentId);
            expect(expected).toBeDefined();
            expect(card.status).toBe(expected!.status);
            expect(card.startedAt).toBe(expected!.startedAt);
            const terminal = TERMINAL.has(expected!.status);
            expect(card.completedAt !== undefined).toBe(terminal);
            if (terminal) {
              expect(card.completedAt).toBe(expected!.completedAt);
              expect(card.completedAt!).toBeGreaterThanOrEqual(card.startedAt!);
              expect(card.lastMessage).toBe(expected!.lastMessage);
            } else {
              expectedActive += 1;
              expect(card.lastMessage).toBeUndefined();
            }
          }
          expect(tracker.activeCount()).toBe(expectedActive);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("extracts Antigravity invoke_subagent details and avoids generic 'Run invoke_subagent' labels", () => {
    const details = readAcpInvokeSubAgentDetails({
      sessionUpdate: "tool_call",
      toolCallId: "call_7559445546344402176",
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
    expect(details).toEqual({
      role: "PwrAgent Transcript Auditor",
      typeName: "research",
      prompt: "Audit PwrAgent transcript UX",
    });
    expect(formatAcpInvokeSubAgentLabel(details!, "in_progress")).toBe("Sub-agent: PwrAgent Transcript Auditor");
    expect(formatAcpInvokeSubAgentLabel(details!, "failed")).toBe("Sub-agent failed: PwrAgent Transcript Auditor");
  });

  it("handles sparse Antigravity tool_call_update failures and sparse manage_subagents kill completions", () => {
    let clock = 1_000;
    const tracker = new AcpSubAgentTracker(() => (clock += 100));

    expect(tracker.apply({
      backendId: "acp:antigravity",
      turnId: "t1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        name: "invoke_subagent",
        title: "Run invoke_subagent",
        status: "in_progress",
        args: { Role: "Auditor 1", TypeName: "research", Prompt: "Audit A" },
      },
    })).toBe(true);
    expect(tracker.apply({
      backendId: "acp:antigravity",
      turnId: "t1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_2",
        name: "invoke_subagent",
        title: "Run invoke_subagent",
        status: "in_progress",
        args: { Role: "Auditor 2", TypeName: "research", Prompt: "Audit B" },
      },
    })).toBe(true);

    // Sparse failure update omits name/title/args.
    expect(tracker.apply({
      backendId: "acp:antigravity",
      turnId: "t1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_2",
        status: "failed",
      },
    })).toBe(true);
    expect(tracker.subAgentCards().find((c) => c.subAgentId === "call_2")?.status).toBe("failure");

    // Sparse manage_subagents kill_all: args on in_progress, omitted on completed.
    expect(tracker.apply({
      backendId: "acp:antigravity",
      turnId: "t1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_kill",
        name: "manage_subagents",
        status: "in_progress",
        args: { Action: "kill_all" },
      },
    })).toBe(false);
    expect(tracker.apply({
      backendId: "acp:antigravity",
      turnId: "t1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_kill",
        status: "completed",
      },
    })).toBe(true);
    expect(tracker.subAgentCards().find((c) => c.subAgentId === "call_1")?.status).toBe("cancelled");
  });
});

describe("AcpSessionReplayNormalizer turn-index differential oracle", () => {
  it("matches full-scan turn completion and waiting-activity removal across multi-turn streams", () => {
    type TurnOp =
      | { op: "prompt"; turn: number; waiting: boolean; text: string }
      | { op: "tool"; id: string; title: string; status: "in_progress" | "completed" }
      | { op: "chunk"; text: string }
      | { op: "finish"; status: "completed" | "interrupted" }
      | { op: "fail"; error: string }
      | { op: "rewind"; promptIndex: number };

    const opArb: fc.Arbitrary<TurnOp> = fc.oneof(
      fc.record({
        op: fc.constant("prompt" as const),
        turn: fc.nat({ max: 20 }),
        waiting: fc.boolean(),
        text: fc.constantFrom("Audit", "Fix bug", "Check tests"),
      }),
      fc.record({
        op: fc.constant("tool" as const),
        id: fc.constantFrom("t1", "t2", "t3"),
        title: fc.constantFrom("read_file", "run_command"),
        status: fc.constantFrom<"in_progress" | "completed">("in_progress", "completed"),
      }),
      fc.record({
        op: fc.constant("chunk" as const),
        text: fc.constantFrom("Working...", "Done."),
      }),
      fc.record({
        op: fc.constant("finish" as const),
        status: fc.constantFrom<"completed" | "interrupted">("completed", "interrupted"),
      }),
      fc.record({
        op: fc.constant("fail" as const),
        error: fc.constantFrom("Provider error", "Timed out"),
      }),
      fc.record({
        op: fc.constant("rewind" as const),
        promptIndex: fc.nat({ max: 3 }),
      }),
    );

    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 30 }), (ops) => {
        const normalizer = new AcpSessionReplayNormalizer();
        let seq = 0;
        let ts = 1_000_000;
        const completedTurns = new Map<string, { status: string; completedAt: number }>();
        let activeTurnId: string | undefined;

        for (const op of ops) {
          ts += 100;
          if (op.op === "prompt") {
            const turnId = `turn-${seq += 1}`;
            activeTurnId = turnId;
            normalizer.recordUserPrompt({
              sessionId: "s1",
              prompt: op.text,
              turnId,
              receivedAt: ts,
              waitingForAgent: op.waiting,
            });
          } else if (op.op === "tool") {
            normalizer.apply({
              sessionId: "s1",
              receivedAt: ts,
              update: {
                sessionUpdate: op.status === "in_progress" ? "tool_call" : "tool_call_update",
                toolCallId: `${op.id}-${seq}`,
                title: op.title,
                status: op.status,
              },
            });
          } else if (op.op === "chunk") {
            normalizer.apply({
              sessionId: "s1",
              receivedAt: ts,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: op.text },
              },
            });
          } else if (op.op === "finish") {
            if (activeTurnId) {
              completedTurns.set(activeTurnId, { status: op.status, completedAt: ts });
            }
            normalizer.recordTurnFinished(undefined, ts, op.status);
            activeTurnId = undefined;
          } else if (op.op === "fail") {
            const turnId = activeTurnId ?? `turn-${seq += 1}`;
            completedTurns.set(turnId, { status: "failed", completedAt: ts });
            normalizer.recordTurnFailed({
              sessionId: "s1",
              turnId,
              error: op.error,
              receivedAt: ts,
            });
            activeTurnId = undefined;
          } else {
            normalizer.rewindToPromptIndex(op.promptIndex, { missingTarget: "clear" });
            activeTurnId = undefined;
            completedTurns.clear();
          }

          const replay = normalizer.replay();
          // Oracle invariant 1: no completed turn may still have any entry stuck in_progress.
          for (const entry of replay.entries) {
            if (entry.turn && completedTurns.has(entry.turn.id)) {
              const expected = completedTurns.get(entry.turn.id)!;
              expect(entry.turn.status).toBe(expected.status);
              expect(entry.turn.completedAt).toBe(expected.completedAt);
            }
          }
          // Oracle invariant 2: at most one waiting activity exists, and only while activeTurnId is set.
          const waitingEntries = replay.entries.filter((entry) => entry.id.startsWith("agent-waiting:"));
          expect(waitingEntries.length).toBeLessThanOrEqual(activeTurnId ? 1 : 0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("removes a superseded turn's waiting activity when a new prompt arrives before it settles", () => {
    // Shrunk counterexample found by the turn-index MBT oracle:
    // prompt(waiting:true) -> prompt(waiting:false) -> fail -> chunk.
    const normalizer = new AcpSessionReplayNormalizer();
    normalizer.recordUserPrompt({
      sessionId: "s1",
      prompt: "Audit",
      turnId: "turn-1",
      receivedAt: 1_000,
      waitingForAgent: true,
    });
    normalizer.recordUserPrompt({
      sessionId: "s1",
      prompt: "Audit",
      turnId: "turn-2",
      receivedAt: 1_100,
      waitingForAgent: false,
    });
    normalizer.recordTurnFailed({
      sessionId: "s1",
      turnId: "turn-2",
      error: "Provider error",
      receivedAt: 1_200,
    });
    normalizer.apply({
      sessionId: "s1",
      receivedAt: 1_300,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Working..." },
      },
    });

    const waiting = normalizer.replay().entries.filter((entry) =>
      entry.id.startsWith("agent-waiting:"),
    );
    expect(waiting).toEqual([]);
  });

  it("removes waiting rows in O(1) without rebuilding entry indexes when subagent_spawned or compaction arrives before assistant text", () => {
    // Counterexample from the scaling audit: previously, subagent_spawned and
    // auto_compact_started appended after agent-waiting:<turnId>, forcing an
    // O(n) filter + rebuildEntryIndexes() per turn (O(n²) across multi-turn
    // streams and rollouts).
    const normalizer = new AcpSessionReplayNormalizer();
    const proto = AcpSessionReplayNormalizer.prototype as unknown as {
      rebuildEntryIndexes: () => void;
    };
    const rebuildSpy = vi.spyOn(proto, "rebuildEntryIndexes");
    try {
      for (let i = 0; i < 20; i += 1) {
        const turnId = `turn-${i}`;
        normalizer.recordUserPrompt({
          sessionId: "s1",
          prompt: `Prompt ${i}`,
          turnId,
          receivedAt: 1_000 + i * 100,
          waitingForAgent: true,
        });
        normalizer.apply({
          sessionId: "s1",
          receivedAt: 1_010 + i * 100,
          update: i % 2 === 0
            ? {
                sessionUpdate: "subagent_spawned",
                subagent_id: `sub-${i}`,
                description: `Worker ${i}`,
                subagent_type: "research",
              }
            : {
                sessionUpdate: "auto_compact_started",
                percentage: 85,
              },
        });
        normalizer.apply({
          sessionId: "s1",
          receivedAt: 1_020 + i * 100,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Reply ${i}` },
          },
        });
        normalizer.recordTurnFinished(turnId, 1_030 + i * 100);
      }
      expect(rebuildSpy).not.toHaveBeenCalled();
      expect(normalizer.replay().entries.filter((e) => e.id.startsWith("agent-waiting:"))).toEqual([]);
    } finally {
      rebuildSpy.mockRestore();
    }
  });

  it("drains only dirty sub-agent cards per flush and re-queues failed IDs via markDirty", () => {
    let clock = 1_000;
    const tracker = new AcpSubAgentTracker(() => (clock += 10));
    for (let i = 0; i < 30; i += 1) {
      const turnId = `turn-${i}`;
      tracker.apply({
        turnId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `call-${i}`,
          title: "Run invoke_subagent",
          status: "in_progress",
          rawInput: { Role: `Worker ${i}`, TypeName: "research", Prompt: `Task ${i}` },
        },
      });
      const launched = tracker.takeDirtySubAgentCards();
      expect(launched).toHaveLength(1);
      expect(launched[0]?.subAgentId).toBe(`call-${i}`);
      expect(tracker.activeCount()).toBe(1);

      tracker.settleTurn({ turnId, outcome: "completed" });
      const settled = tracker.takeDirtySubAgentCards();
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe("success");
      expect(tracker.activeCount()).toBe(0);
      expect(tracker.takeDirtySubAgentCards()).toEqual([]);
    }
    tracker.markDirty(["call-29"]);
    expect(tracker.takeDirtySubAgentCards().map((c) => c.subAgentId)).toEqual(["call-29"]);
  });
});
