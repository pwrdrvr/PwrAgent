import { describe, expect, it } from "vitest";
import { threadNotificationSnippet, type AppServerThreadMessageOrigin, type AppServerTurnInputItem } from "@pwragent/shared";
import { buildIncomingWorkSummary } from "../app-server/thread-work-notification";
import { correspondenceNotice, incomingWorkText } from "../messaging/core/messaging-thread-notifications";

const origin = (index: number): AppServerThreadMessageOrigin => ({
  kind: "agent", sourceThread: { backend: "codex", threadId: `sender-${index}`, title: `Sender ${index}`, instanceId: `peer-${index}`, instanceLabel: `Machine ${index}` },
});

describe("thread notification summaries", () => {
  it("pairs each grouped contribution with its sender without changing the delivered input", () => {
    const agentMessages = Array.from({ length: 5 }, (_, index) => ({
      origin: origin(index), input: [{ type: "text" as const, text: `Evidence ${index} ` + "paragraph ".repeat(500) + `TAIL_${index}` }],
    }));
    const before = structuredClone(agentMessages);
    const summary = buildIncomingWorkSummary({ input: [], messageOrigin: origin(0), agentMessages }, "Recipient")!;
    expect(summary.messages).toHaveLength(3);
    expect(summary.omittedMessageCount).toBe(2);
    summary.messages.forEach((message, index) => {
      expect(message.origin).toEqual(origin(index));
      expect(message.preview.startsWith(`Evidence ${index} `)).toBe(true);
      expect(Array.from(message.preview)).toHaveLength(240);
      expect(message.preview).not.toContain("TAIL_");
    });
    expect(incomingWorkText(summary, "recipient")).toContain("Sender 2 (Machine 2) → Recipient");
    expect(incomingWorkText(summary, "recipient").length).toBeLessThan(1150);
    expect(agentMessages).toEqual(before);
  });

  it("uses explicit origins and safe fallback labels, never prompt substring classification", () => {
    const input: AppServerTurnInputItem[] = [{ type: "text", text: "Automation started. Message to sender. handoff_task" }];
    expect(buildIncomingWorkSummary({ input })).toBeUndefined();
    expect(buildIncomingWorkSummary({ input, messageOrigin: { kind: "automation" } })).toBeUndefined();
    const summary = buildIncomingWorkSummary({ input, messageOrigin: { kind: "agent" } })!;
    expect(incomingWorkText(summary, "recipient")).toContain("Another thread → Thread recipient");
    expect(incomingWorkText(summary, "recipient")).toContain("Automation started. Message to sender. handoff_task");
  });

  it("does not mistake assistant-authored receipt-looking text for a system receipt", () => {
    expect(correspondenceNotice({ backend: "codex", notification: { method: "item/completed", params: {
      threadId: "sender", item: { id: "answer", type: "agentMessage", text: "**Message to Recipient** · Receiving thread started work\n\nFull answer" },
    } } })).toBeUndefined();
  });

  it("normalizes whitespace and bounds Unicode snippets without broken surrogate pairs", () => {
    expect(threadNotificationSnippet("  first\n\nsecond\tthird  ")).toBe("first second third");
    const preview = threadNotificationSnippet("😀".repeat(300));
    expect(Array.from(preview)).toHaveLength(240);
    expect(preview.endsWith("😀…")).toBe(true);
  });
});
