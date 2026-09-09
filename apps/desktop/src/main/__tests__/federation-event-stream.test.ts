import { describe, expect, it } from "vitest";
import type { AgentEvent, ThreadToolInvocationRecord } from "@pwragent/shared";
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
