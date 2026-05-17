import { describe, expect, it } from "vitest";
import { AcpSessionReplayNormalizer } from "../acp/acp-session-normalizer";

describe("AcpSessionReplayNormalizer", () => {
  it("streams assistant message chunks into one replay message", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: { kind: "agent_message_chunk", content: "Hello " },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: { kind: "agent_message_chunk", content: "world" },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({ role: "assistant", text: "Hello world" }),
    ]);
    expect(replay.lastAssistantMessage).toBe("Hello world");
  });

  it("upserts plans and tool activities", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        kind: "plan",
        steps: [{ step: "Inspect files", status: "in_progress" }],
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        kind: "tool_call",
        id: "tool-1",
        title: "Read package.json",
        status: "completed",
        path: "package.json",
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "plan",
        steps: [{ step: "Inspect files", status: "in_progress" }],
      }),
      expect.objectContaining({
        type: "activity",
        id: "tool-1",
        summary: "Read package.json",
        status: "completed",
      }),
    ]);
  });

  it("preserves unknown update variants as structured activity", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: { kind: "future_update" },
    });

    expect(replay.entries[0]).toMatchObject({
      type: "activity",
      summary: "ACP update: future_update",
    });
  });
});
