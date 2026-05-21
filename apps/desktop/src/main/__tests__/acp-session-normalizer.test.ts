import { describe, expect, it } from "vitest";
import {
  AcpSessionReplayNormalizer,
  readAcpTopicTitle,
} from "../acp/acp-session-normalizer";

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

  it("reads ACP text content blocks from assistant chunks", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "OK." },
      },
    });

    expect(replay.lastAssistantMessage).toBe("OK.");
  });

  it("records local user prompts as active replay state", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const activeReplay = normalizer.recordUserPrompt({
      sessionId: "session-1",
      prompt: "hello",
      turnId: "pending:session-1",
      receivedAt: 1000,
    });
    const idleReplay = normalizer.recordTurnFinished();

    expect(activeReplay).toMatchObject({
      lastUserMessage: "hello",
      threadStatus: "active",
    });
    expect(activeReplay.messages).toEqual([
      expect.objectContaining({
        id: "user:pending:session-1",
        role: "user",
        text: "hello",
      }),
    ]);
    expect(idleReplay.threadStatus).toBe("idle");
  });

  it("keeps repeated ACP turns in durable order", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "What is this project?",
        turnId: "pending:session-1:1000",
      },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1100,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "It is PwrSnap." },
      },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1200,
      update: {
        kind: "turn_finished",
        turnId: "pending:session-1:1000",
      },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 2000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "What is the CWD?",
        turnId: "pending:session-1:2000",
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 2100,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "/repo/project" },
      },
    });

    expect(replay.messages.map((message) => [message.id, message.text])).toEqual([
      ["user:pending:session-1:1000", "What is this project?"],
      ["assistant:pending:session-1:1000", "It is PwrSnap."],
      ["user:pending:session-1:2000", "What is the CWD?"],
      ["assistant:pending:session-1:2000", "/repo/project"],
    ]);
    expect(replay.lastUserMessage).toBe("What is the CWD?");
    expect(replay.lastAssistantMessage).toBe("/repo/project");
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

  it("uses ACP sessionUpdate over tool kind when normalizing tool calls", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read-file-1",
        kind: "read",
        title: "README.md",
        status: "completed",
        locations: [{ path: "/repo/README.md" }],
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "read-file-1",
        summary: "README.md",
        status: "completed",
        details: [
          expect.objectContaining({
            kind: "read",
            label: "README.md",
            path: "/repo/README.md",
          }),
        ],
      }),
    ]);
  });

  it("ignores available command updates in transcripts", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "help" }],
      },
    });

    expect(replay.entries).toEqual([]);
  });

  it("extracts ACP topic updates without rendering transcript activity", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "update_topic_1",
        kind: "think",
        title: 'Update topic to: "Exploring PwrSnap Project"',
        status: "completed",
      },
    });

    expect(
      readAcpTopicTitle({
        sessionUpdate: "tool_call",
        kind: "think",
        title: 'Update topic to: "Exploring PwrSnap Project"',
      }),
    ).toBe("Exploring PwrSnap Project");
    expect(replay.entries).toEqual([]);
  });

  it("records thought chunks as assistant commentary", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Inspecting project files." },
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "message",
        id: "thought:session-1",
        role: "assistant",
        phase: "commentary",
        text: "Inspecting project files.",
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
