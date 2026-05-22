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

  it("renders ACP user message chunks as transcript messages", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "What is the CWD?" },
      },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "What is the CWD?",
      }),
    ]);
    expect(replay.lastUserMessage).toBe("What is the CWD?");
    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        text: "What is the CWD?",
      }),
    ]);
  });

  it("does not duplicate ACP user echo chunks for a locally recorded prompt", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.recordUserPrompt({
      sessionId: "session-1",
      prompt: "What is this project?",
      turnId: "pending:session-1:1000",
      receivedAt: 1000,
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "What is " },
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1002,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "this project?" },
      },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({
        id: "user:pending:session-1:1000",
        role: "user",
        text: "What is this project?",
      }),
    ]);
  });

  it("does not render Gemini mode marker chunks as assistant text", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "[MODE_UPDATE] yolo" },
      },
    });

    expect(replay.entries).toEqual([]);
    expect(replay.lastAssistantMessage).toBeUndefined();
  });

  it("preserves markdown block boundaries across ACP thought chunks", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "I found the thread creation path.",
        },
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "**Refining Button Logic**\nI am checking the disabled state.",
        },
      },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        text:
          "I found the thread creation path.\n\n" +
          "**Refining Button Logic**\nI am checking the disabled state.",
      }),
    ]);
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

  it("keeps persisted user prompt image parts out of transcript text", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    const imageUrl = "data:image/png;base64,aGVsbG8=";

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "What's in this image?",
        parts: [
          { type: "text", text: "What's in this image?" },
          { type: "image", url: imageUrl, alt: "Pasted image" },
        ],
        turnId: "pending:session-1:1000",
      },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "What's in this image?",
        parts: [
          { type: "text", text: "What's in this image?" },
          { type: "image", url: imageUrl, alt: "Pasted image" },
        ],
      }),
    ]);
    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        text: "What's in this image?",
        parts: [
          { type: "text", text: "What's in this image?" },
          { type: "image", url: imageUrl, alt: "Pasted image" },
        ],
      }),
    ]);
    expect(replay.lastUserMessage).toBe("What's in this image?");
  });

  it("repairs legacy data URL image markers in persisted ACP prompts", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    const imageUrl = "data:image/png;base64,aGVsbG8=";

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: `What's in this image?\n[Image: ${imageUrl}]`,
        turnId: "pending:session-1:1000",
      },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "What's in this image?",
        parts: [
          { type: "text", text: "What's in this image?" },
          { type: "image", url: imageUrl },
        ],
      }),
    ]);
    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        text: "What's in this image?",
        parts: [
          { type: "text", text: "What's in this image?" },
          { type: "image", url: imageUrl },
        ],
      }),
    ]);
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

  it("merges ACP tool call updates into the original activity", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "run-pwd",
        kind: "execute",
        title: "pwd",
        status: "pending",
        command: "pwd",
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "run-pwd",
        kind: "execute",
        status: "completed",
        output: "/repo/project\n",
        exitCode: 0,
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "run-pwd",
        summary: "pwd",
        status: "completed",
        details: [
          expect.objectContaining({
            kind: "command",
            label: "pwd",
            command: {
              displayCommand: "pwd",
              rawCommand: "pwd",
              output: "/repo/project\n",
              exitCode: 0,
            },
          }),
        ],
      }),
    ]);
  });

  it("extracts nested ACP tool update content as command output", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read-file-1",
        kind: "read",
        title: "README.md",
        status: "in_progress",
        locations: [{ path: "/repo/README.md" }],
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "read-file-1",
        kind: "read",
        title: "README.md",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Read lines 1-80 of 200 from README.md",
            },
          },
        ],
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
            command: expect.objectContaining({
              displayCommand: "README.md",
              output: "Read lines 1-80 of 200 from README.md",
            }),
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

  it("records PwrAgent turn failures as warning activity", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        kind: "pwragent_turn_failed",
        turnId: "turn-1",
        error:
          "json-rpc error (500): You have exhausted your capacity on this model.",
      },
    });

    expect(replay.threadStatus).toBe("idle");
    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "turn-failed:turn-1",
        summary: "Turn failed",
        tone: "warning",
        status: "failed",
        turn: expect.objectContaining({
          id: "turn-1",
          status: "failed",
        }),
        details: [
          expect.objectContaining({
            label:
              "json-rpc error (500): You have exhausted your capacity on this model.",
            status: "failed",
          }),
        ],
      }),
    ]);
  });
});
