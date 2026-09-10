import { describe, expect, it } from "vitest";
import type { AgentEvent, ThreadToolAccounting, ThreadToolInvocationRecord } from "@pwragent/shared";
import { FederationAccountingStream } from "../federation/federation-event-stream";

function invocation(index: number): ThreadToolInvocationRecord {
  return {
    backend: "codex", threadId: "thread-1", itemId: `item-${index}`, invocationId: `call-${index}`,
    toolName: "exec_command", normalizedCommand: `rg needle file-${index}.ts`, category: "search", status: "completed",
    observedAt: index, updatedAt: index, outputChars: 100, outputLines: 10, estimatedOutputTokens: 25,
    warningLines: 0, errorLines: 0, infoLines: 0, debugLines: 0, outputTruncated: false, noisy: false,
  };
}

function accounting(invocations: ThreadToolInvocationRecord[]): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "thread/toolAccounting/updated",
      params: { threadId: "thread-1", toolAccounting: { alerts: [], summaries: [], invocations } },
    },
  };
}

describe("federation accounting stream", () => {
  it("keeps a busy minute proportional to changes rather than accumulated tool history", () => {
    const sender = new FederationAccountingStream();
    const receiver = new FederationAccountingStream();
    const invocations = Array.from({ length: 500 }, (_, index) => invocation(index));
    let fullBytes = 0;
    let wireBytes = 0;
    for (let sequence = 1; sequence <= 61; sequence += 1) {
      // Include a changing existing record as well as appended history.
      invocations[0] = { ...invocations[0]!, updatedAt: sequence, outputChars: sequence * 100 };
      invocations.push(invocation(500 + sequence));
      const event = accounting(invocations);
      const encoded = sender.encode(event, { epoch: "stream-1", sequence });
      wireBytes += Buffer.byteLength(JSON.stringify(encoded));
      fullBytes += Buffer.byteLength(JSON.stringify(event));
      expect(receiver.decode(JSON.parse(JSON.stringify(encoded)))).toEqual(event);
    }
    // Deliberate bandwidth budget: less than 1 MB for the initial history and
    // sixty updates, and at least a 95% reduction versus full notifications.
    expect(wireBytes).toBeLessThan(1_000_000);
    expect(wireBytes / fullBytes).toBeLessThan(0.05);
  });

  it("keeps sorted history rotations and fixed-size replacements below 4 KB", () => {
    const sender = new FederationAccountingStream();
    const receiver = new FederationAccountingStream();
    let values = Array.from({ length: 500 }, (_, index) => invocation(index));
    receiver.decode(sender.encode(accounting(values), { epoch: "s", sequence: 1 }));
    for (let sequence = 2; sequence < 22; sequence += 1) {
      const moved = values.pop()!;
      values = [{ ...moved, updatedAt: sequence, outputChars: sequence * 100 }, ...values];
      if (sequence % 2 === 0) values = [...values.slice(1), invocation(500 + sequence)];
      const event = accounting(values);
      const encoded = sender.encode(event, { epoch: "s", sequence });
      expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(4_000);
      expect(receiver.decode(JSON.parse(JSON.stringify(encoded)))).toEqual(event);
    }
  });

  it("does not resend large Token Miser summaries when interceptions change order", () => {
    const sender = new FederationAccountingStream();
    const receiver = new FederationAccountingStream();
    const interceptions = Array.from({ length: 100 }, (_, index) => ({
      objectId: `output-${index}`, turnId: "turn", toolUseId: `tool-${index}`, toolName: "exec_command", createdAt: index,
      originalCharacters: 10000, baselineParentTokens: 2500, replacementTokens: 500, retrievedTokens: 0, estimatedParentTokensSaved: 2000,
      summary: { summary: "Retained output summary ".repeat(100), usefulDetails: [] },
    }));
    const event = accounting([]);
    if (event.notification.method !== "thread/toolAccounting/updated") throw new Error("Expected accounting fixture");
    (event.notification.params as { toolAccounting: ThreadToolAccounting }).toolAccounting.tokenMiser = {
      interceptionCount: 100, originalCharacters: 1000000, baselineParentTokens: 250000, replacementTokens: 50000,
      retrievedTokens: 0, estimatedParentTokensSaved: 200000, interceptions,
    };
    receiver.decode(sender.encode(event, { epoch: "s", sequence: 1 }));
    const moved = interceptions.pop()!;
    interceptions.unshift({ ...moved, retrievedTokens: 10 });
    const encoded = sender.encode(event, { epoch: "s", sequence: 2 });
    expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(4_000);
    expect(receiver.decode(encoded)).toEqual(event);
  });

  it("patches repeated subagent metadata", () => {
    const sender = new FederationAccountingStream();
    const receiver = new FederationAccountingStream();
    const event: AgentEvent = { backend: "codex", notification: { method: "thread/subAgents/updated", params: {
      threadId: "thread-1", subAgents: Array.from({ length: 100 }, (_, index) => ({
        monitorId: `monitor-${index}`, task: "Large historical task ".repeat(100), status: "success", createdAt: index, updatedAt: index,
      })),
    } } };
    for (let sequence = 1; sequence < 4; sequence += 1) {
      const encoded = sender.encode(event, { epoch: "s", sequence });
      expect(receiver.decode(encoded)).toEqual(event);
      if (sequence > 1) expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(500);
    }
  });

  it("round trips prepends, truncation, nested edits and optional field removal", () => {
    const sender = new FederationAccountingStream();
    const receiver = new FederationAccountingStream();
    let invocations = Array.from({ length: 100 }, (_, index) => invocation(index));
    const events = [accounting(invocations)];
    invocations = [invocation(101), ...invocations];
    events.push(accounting(invocations));
    invocations = invocations.slice(0, 99).map((item, index) => index === 2 ? { ...item, suggestedPrompt: "less output" } : item);
    events.push(accounting(invocations));
    invocations = invocations.map(({ suggestedPrompt: _prompt, ...item }) => item);
    events.push(accounting(invocations));
    events.forEach((event, index) => expect(receiver.decode(sender.encode(event, { epoch: "s", sequence: index + 1 }))).toEqual(event));
  });

  it("rejects a patch without its baseline, and a new stream sends a full baseline", () => {
    const sender = new FederationAccountingStream();
    const receiver = new FederationAccountingStream();
    const event = accounting(Array.from({ length: 100 }, (_, index) => invocation(index)));
    sender.encode(event, { epoch: "s", sequence: 1 });
    const patch = sender.encode(event, { epoch: "s", sequence: 2 });
    expect(patch.accountingPatch).toBeDefined();
    expect(receiver.decode(patch)).toBeUndefined();
    const replacement = new FederationAccountingStream().encode(event, { epoch: "new", sequence: 1 });
    expect(replacement.accountingPatch).toBeUndefined();
    expect(receiver.decode(replacement)).toEqual(event);
  });

  it("bounds retained accounting and leaves ordinary transcript deltas alone", () => {
    const sender = new FederationAccountingStream(100);
    const event = accounting([invocation(1)]);
    sender.encode(event, { epoch: "s", sequence: 1 });
    expect(sender.encode(event, { epoch: "s", sequence: 2 }).accountingPatch).toBeUndefined();
    const delta: AgentEvent = {
      backend: "codex", notification: {
        method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" },
      },
    };
    expect(sender.encode(delta, { epoch: "s", sequence: 3 })).toEqual({ ...delta, stream: { epoch: "s", sequence: 3 } });
  });

  it("rejects prototype paths in a received patch", () => {
    const sender = new FederationAccountingStream();
    const receiver = new FederationAccountingStream();
    const event = accounting([invocation(1)]);
    receiver.decode(sender.encode(event, { epoch: "s", sequence: 1 }));
    const patch = sender.encode(event, { epoch: "s", sequence: 2 });
    patch.accountingPatch!.changes = [{ path: ["__proto__", "injected"], value: true }];
    expect(receiver.decode(patch)).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, "injected")).toBe(false);
  });
});
