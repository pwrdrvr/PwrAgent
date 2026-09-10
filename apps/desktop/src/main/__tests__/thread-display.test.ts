import { expect, it } from "vitest";
import type { AppServerReadThreadResponse, ThreadUsageLineRecord, AgentEvent } from "@pwragent/shared";
import { projectThreadDisplay } from "../app-server/thread-display";
import { projectThreadDisplayEvent } from "../app-server/thread-display-events";
import { conditionalThreadRead } from "../app-server/conditional-thread-read";

function line(index: number): ThreadUsageLineRecord {
  return {
    backend: "codex", threadId: "fixture", usageLineId: "line-" + index, turnId: "turn-" + index,
    scope: "turn", source: "live", status: "finalized", turnUsageAttributed: true,
    provider: "openai", model: "gpt-5.5", currency: "USD", priceStatus: "priced",
    createdAt: 1_800_000_000_000 + index * 1000, startedAt: 1_800_000_000_000 + index * 1000,
    completedAt: 1_800_000_000_999 + index * 1000,
    inputTokens: 100, uncachedInputTokens: 100, cachedInputTokens: 0,
    outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110,
    uncachedInputCostMicros: 500, cachedInputCostMicros: 0, outputCostMicros: 100, totalCostMicros: 600,
  };
}
function snapshot(count: number): AppServerReadThreadResponse {
  const visible = { type: "message" as const, role: "assistant" as const, id: "visible-message", text: "Visible answer", turn: { id: "turn-0", status: "completed" as const, startedAt: line(0).startedAt, completedAt: line(0).completedAt } };
  return {
    backend: "codex", threadId: "fixture", fetchedAt: 1_800_100_000_000,
    replay: { entries: [visible], messages: [visible], lastAssistantMessage: visible.text, pagination: { supportsPagination: true, hasPreviousPage: true, previousCursor: "older" } },
    pricing: { lines: Array.from({ length: count }, (_, index) => line(index)), summaries: [] },
    toolAccounting: {
      alerts: [], summaries: [], invocations: [],
      tokenMiser: { interceptionCount: count, originalCharacters: count * 1000, baselineParentTokens: count * 250, replacementTokens: count * 25, retrievedTokens: 0, estimatedParentTokensSaved: count * 225,
        codeMode: {
          callCount: count, commandCellCount: null, directCommandCellCount: null, dispatchClusterCount: null,
          multiInvocationClusterCount: null, largestDispatchCluster: null, nestedCommandInvocationCount: null,
          patchCellCount: null, otherCellCount: null, pollingCellCount: null,
          directCount: count, summarizedCount: 0, passThroughCount: 0, retrievalCount: 0, capturedNestedInvocationCount: null,
          observations: Array.from({ length: count }, (_, index) => ({
            observationId: "observation-" + index, turnId: "turn-" + index, callId: "call-" + index, cellId: "cell-" + index,
            createdAt: line(index).createdAt, outputCharacters: 10, maxOutputTokens: 1000, scriptStatus: "completed",
            retrieval: false, capturedNestedInvocationCount: null, disposition: "direct",
            script: "raw code that is not a display field",
          })),
        },
      },
    },
  };
}

it("keeps initial display bytes independent of historical accounting and sends transcript text once", () => {
  const small = projectThreadDisplay(snapshot(10), { threadId: "fixture", display: { resource: "transcript" } });
  const large = projectThreadDisplay(snapshot(10_000), { threadId: "fixture", display: { resource: "transcript" } });
  const encoded = JSON.stringify(large);
  expect(encoded.match(/Visible answer/g)).toHaveLength(1);
  expect(large.pricing).toBeUndefined();
  expect(large.toolAccounting).toBeUndefined();
  expect(large.replay.messages).toEqual([]);
  expect(large.replay.entries.some((entry) => entry.type === "activity" && entry.summary.startsWith("Turn usage:"))).toBe(true);
  expect(encoded).not.toContain("usageLineId");
  expect(encoded).not.toContain("raw code");
  expect(Buffer.byteLength(encoded)).toBeLessThan(8_000);
  expect(Buffer.byteLength(encoded) - Buffer.byteLength(JSON.stringify(small))).toBeLessThan(300);
  expect(large.display?.pricing.summary?.totalCostMicros).toBe(6_000_000);
});

it("pages owner-prepared pricing rows while keeping totals over the full history", () => {
  const data = snapshot(45);
  const first = projectThreadDisplay(data, { threadId: "fixture", display: { resource: "pricing", limit: 20 } });
  const second = projectThreadDisplay(data, { threadId: "fixture", display: { resource: "pricing", limit: 20, cursor: first.display?.nextCursor } });
  const third = projectThreadDisplay(data, { threadId: "fixture", display: { resource: "pricing", limit: 20, cursor: second.display?.nextCursor } });
  expect([first, second, third].map((page) => page.display?.pricingPage?.rows.length)).toEqual([20, 20, 5]);
  expect(third.display?.nextCursor).toBeUndefined();
  expect(second.display?.pricingPage?.summary?.totalCostMicros).toBe(27_000);
  expect(first.display?.pricingPage?.rows[0]?.lineTotals?.runningCostMicros).toBe(27_000);
  expect(second.display?.pricingPage?.rows[0]?.lineTotals?.runningCostMicros).toBe(15_000);
  expect(() => projectThreadDisplay(snapshot(46), { threadId: "fixture", display: { resource: "pricing", cursor: first.display?.nextCursor } })).toThrow(/history changed/);
});

it("revalidates a transcript when only undisplayed overlay or ledger metadata changed", () => {
  const data = snapshot(2);
  const request = { threadId: "fixture", display: { resource: "transcript" as const } };
  // The registry passes the complete overlay object, not just the fields in
  // projectThreadDisplay's parameter type. Selected-thread enrichment changes it.
  const overlay = { reasoningEffort: "high", lastSeenAt: 100, updatedAt: 200 };
  const first = conditionalThreadRead(projectThreadDisplay(data, request, overlay), "");
  const next = snapshot(2);
  next.fetchedAt += 1_000;
  next.toolAccounting!.tokenMiser!.codeMode!.observations![0]!.script = "Different internal accounting evidence";
  const updatedOverlay = { ...overlay, lastSeenAt: 300, updatedAt: 400 };
  const repeated = conditionalThreadRead(projectThreadDisplay(next, request, updatedOverlay), first.replayRevision);
  expect(repeated.unchanged).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(repeated))).toBeLessThan(400);

  next.replay.entries[0] = { type: "message", id: "visible-message", role: "assistant", text: "Changed answer" };
  expect(conditionalThreadRead(projectThreadDisplay(next, request, overlay), first.replayRevision).unchanged).not.toBe(true);
});

it("sends a large plain-text message once without dropping attachment parts", () => {
  const data = snapshot(0);
  const text = "Contrived federation log line: request completed.\n".repeat(8_000);
  data.replay.entries = [{ type: "message", id: "log", role: "user", text, parts: [{ type: "text", text }] }];
  data.replay.messages = [];
  const projected = projectThreadDisplay(data, { threadId: "fixture", display: { resource: "transcript" } });
  expect(projected.replay.entries[0]).toMatchObject({ text, parts: undefined });
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(Buffer.byteLength(JSON.stringify(data)) * 0.51);
  expect(data.replay.entries[0]!.type === "message" && data.replay.entries[0]!.parts).toEqual([{ type: "text", text }]);

  const parts = [{ type: "text" as const, text }, { type: "file" as const, name: "capture.log", mimeType: "text/plain" }];
  data.replay.entries = [{ type: "message", id: "file", role: "user", text, parts }];
  expect(projectThreadDisplay(data, { threadId: "fixture", display: { resource: "transcript" } }).replay.entries[0]).toMatchObject({ text, parts });
});

it("defers completed provider activity bodies only for a viewer that can resolve them", () => {
  const data = snapshot(0);
  const output = "Full command output\n".repeat(20_000);
  const activity = {
    type: "activity" as const, id: "activity-command", summary: "Ran a command", status: "completed" as const,
    turn: { id: "turn", status: "completed" as const },
    details: [{ id: "command", kind: "command" as const, label: "test", command: { displayCommand: "pnpm test", rawCommand: "bash -c pnpm test", output } }],
  };
  data.replay.entries = [activity];
  data.replay.messages = [];
  const request = { threadId: "fixture", display: { resource: "transcript" as const, deferActivityDetails: true } };
  const projected = projectThreadDisplay(data, request);
  expect(projected.replay.entries[0]).toMatchObject({ summary: activity.summary,
    detailsRef: { threadId: "fixture", backend: "codex", entryId: activity.id, turnId: "turn" },
    details: [{ id: "command", kind: "command", label: "test", command: { output: undefined, rawCommand: undefined } }],
  });
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(2_000);
  expect(activity.details[0]!.command.output).toBe(output);
  expect(projectThreadDisplay(data, { threadId: "fixture", display: { resource: "transcript" } }).replay.entries[0]).toMatchObject({ details: activity.details });
  for (const inline of [
    { ...activity, turn: undefined },
    { ...activity, turn: { id: "turn", status: "in_progress" as const } },
    { ...activity, id: "codex-environment-setup" },
    { ...activity, details: [{ ...activity.details[0]!, command: { ...activity.details[0]!.command, rawCommand: "pwragent.read_thread" } }] },
  ]) {
    expect(projectThreadDisplay({ ...data, replay: { ...data.replay, entries: [inline] } }, request).replay.entries[0]).not.toHaveProperty("detailsRef");
  }
  const fileDiff = { kind: "update" as const, diff: "+changed line", additions: 1, removals: 0 };
  const withEdits = { ...activity, details: [...activity.details, { id: "edit", kind: "write" as const, label: "Edited file", fileDiff }] };
  const projectedEdits = projectThreadDisplay({ ...data, replay: { ...data.replay, entries: [withEdits] } }, request).replay.entries[0];
  expect(projectedEdits).toMatchObject({ detailsRef: { entryId: activity.id }, details: [{ command: { output: undefined } }, { fileDiff }] });
});

it("returns a late usage correction only for the requested loaded turn", () => {
  const data = snapshot(1000);
  data.pricing!.lines[0]!.totalCostMicros = 9_000;
  const result = projectThreadDisplay({ ...data, replay: { ...data.replay, entries: [] } }, {
    threadId: "fixture", display: { resource: "accounting", turns: [{ id: "turn-0", status: "completed", completedAt: line(0).completedAt }] },
  });
  expect(result.replay.entries).toHaveLength(1);
  expect(result.replay.entries[0]).toMatchObject({ id: "live-turn-usage-turn-0", turn: { id: "turn-0" } });
  expect(JSON.stringify(result)).not.toContain("line-999");
  expect(result.pricing).toBeUndefined();
});

it("does not send a full ledger on the first accounting event", () => {
  const data = snapshot(1000);
  const event: AgentEvent = { backend: "codex", notification: { method: "thread/pricing/updated", params: { threadId: "fixture", pricing: data.pricing! } } };
  const result = projectThreadDisplayEvent(event);
  expect(result.notification.params).toMatchObject({ displayInvalidated: true, pricing: { lines: [], summaries: [] } });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(300);
  expect(data.pricing!.lines).toHaveLength(1000);
});

it("keeps messages missing from the provider timeline and never includes transcript bodies in a panel page", () => {
  const data = snapshot(2);
  data.replay.messages.push({ id: "message-only", role: "user", text: "A message without a timeline entry" });
  const result = projectThreadDisplay(data, { threadId: "fixture", display: { resource: "transcript" } });
  expect(result.replay.entries).toContainEqual({ id: "message-only", role: "user", type: "message", text: "A message without a timeline entry" });
  const pricing = projectThreadDisplay(data, { threadId: "fixture", display: { resource: "pricing" } });
  expect(pricing.replay.entries).toEqual([]);
  expect(JSON.stringify(pricing)).not.toContain("Visible answer");
});

it("selects one authoritative correction and completes stale running turn metadata", () => {
  const data = snapshot(2);
  data.pricing!.lines.push({ ...line(0), usageLineId: "new-authoritative", totalCostMicros: 1000 });
  const result = projectThreadDisplay(data, { threadId: "fixture", display: { resource: "accounting", turns: [{ id: "turn-0", status: "in_progress" }] } });
  expect(result.replay.entries).toHaveLength(1);
  expect(result.replay.entries[0]).toMatchObject({ turn: { id: "turn-0", status: "completed", durationMs: 999 } });
  expect(projectThreadDisplay(data, { threadId: "fixture", display: { resource: "accounting", turns: [{ id: "turn-0", status: "in_progress" }] } }, { activeTurnId: "turn-0" }).replay.entries).toEqual([]);
});

it("pages each sub-agent category independently with counts over its complete history", () => {
  const data = snapshot(1);
  const agents = ["codex-native:", "system:token-miser:", "monitor:"].flatMap((prefix) => Array.from({ length: 23 }, (_, index) => ({
    monitorId: prefix + index, task: "Visible task", status: "running" as const, createdAt: data.fetchedAt - index, updatedAt: data.fetchedAt,
  })));
  const first = projectThreadDisplay(data, { threadId: "fixture", display: { resource: "subagents", limit: 20 } }, { subAgents: agents });
  expect(first.display?.subAgentCounts).toEqual({ harness: 23, "token-miser": 23, pwragent: 23 });
  expect(first.display?.subAgentLens).toBe("harness");
  expect(first.display?.subAgents).toHaveLength(20);
  expect(first.display?.subAgents?.every((agent) => agent.monitorId.startsWith("codex-native:"))).toBe(true);
  const second = projectThreadDisplay(data, { threadId: "fixture", display: { resource: "subagents", cursor: first.display?.nextCursor } }, { subAgents: agents });
  expect(second.display?.subAgents).toHaveLength(3);
  expect(second.display?.nextCursor).toBeUndefined();
  const tokenMiser = projectThreadDisplay(data, { threadId: "fixture", display: { resource: "subagents", subAgentLens: "token-miser" } }, { subAgents: agents });
  expect(tokenMiser.display?.subAgents).toHaveLength(20);
  expect(tokenMiser.display?.subAgents?.every((agent) => agent.monitorId.startsWith("system:token-miser:"))).toBe(true);
  expect(() => projectThreadDisplay(data, { threadId: "fixture", display: { resource: "subagents", subAgentLens: "token-miser", cursor: first.display?.nextCursor } }, { subAgents: agents })).toThrow(/history changed/);
});

it("places message-only provider content before its next timeline message", () => {
  const data = snapshot(1);
  data.replay.messages.unshift({ id: "missing-before", role: "user", text: "Earlier question" });
  const result = projectThreadDisplay(data, { threadId: "fixture", display: { resource: "transcript" } });
  expect(result.replay.entries.slice(0, 2).map((entry) => entry.id)).toEqual(["missing-before", "visible-message"]);
});
