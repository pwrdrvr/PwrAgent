import { describe, expect, it } from "vitest";
import {
  AcpSessionReplayNormalizer,
  inferAcpReplayTurns,
  readAcpTopicTitle,
} from "../acp/acp-session-normalizer";
import grokReviewSession from "./fixtures/grok-managed-review-session.json";

describe("AcpSessionReplayNormalizer", () => {
  it("keeps inferred provider work inside user-message boundaries", () => {
    const replay = inferAcpReplayTurns({
      entries: [
        {
          type: "activity",
          id: "before-user",
          summary: "Provider setup",
          details: [],
          createdAt: 900,
        },
        {
          type: "message",
          id: "user-1",
          role: "user",
          text: "First request",
          createdAt: 1000,
        },
        {
          type: "activity",
          id: "tool-1",
          summary: "First tool",
          details: [],
          createdAt: 1100,
        },
        {
          type: "message",
          id: "final-1",
          role: "assistant",
          phase: "final",
          text: "First response segment",
          createdAt: 1200,
        },
        {
          type: "activity",
          id: "tool-after-final-1",
          summary: "Tool after assistant delivery",
          details: [],
          createdAt: 1300,
        },
        {
          type: "message",
          id: "final-1b",
          role: "assistant",
          phase: "final",
          text: "Second response segment",
          createdAt: 1400,
        },
        {
          type: "message",
          id: "user-2",
          role: "user",
          text: "Second request",
          createdAt: 2000,
        },
        {
          type: "activity",
          id: "tool-2",
          summary: "Second tool",
          details: [],
          createdAt: 2100,
        },
        {
          type: "message",
          id: "user-3",
          role: "user",
          text: "Third request",
          createdAt: 3000,
        },
        {
          type: "activity",
          id: "tool-3",
          summary: "Third tool",
          details: [],
          createdAt: 3100,
        },
      ],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle",
    });

    expect(replay.entries[0]?.turn).toBeUndefined();
    expect(replay.entries[1]?.turn).toEqual({
      id: "inferred:user-1",
      status: "completed",
      startedAt: 1000,
      completedAt: 1400,
      durationMs: 400,
    });
    expect(replay.entries[2]?.turn).toEqual(replay.entries[1]?.turn);
    expect(replay.entries[3]?.turn).toEqual(replay.entries[1]?.turn);
    expect(replay.entries[4]?.turn).toEqual(replay.entries[1]?.turn);
    expect(replay.entries[5]?.turn).toEqual(replay.entries[1]?.turn);
    expect(replay.entries[6]?.turn).toEqual({
      id: "inferred:user-2",
      status: "interrupted",
      startedAt: 2000,
      completedAt: 2100,
      durationMs: 100,
    });
    expect(replay.entries[7]?.turn).toEqual(replay.entries[6]?.turn);
    expect(replay.entries[8]?.turn).toEqual({
      id: "inferred:user-3",
      status: "interrupted",
      startedAt: 3000,
      completedAt: 3100,
      durationMs: 100,
    });
    expect(replay.entries[9]?.turn).toEqual(replay.entries[8]?.turn);
  });

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

  it("prefers a provider timestamp extension over local receipt time", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1_800_000_000_000,
      update: {
        kind: "agent_message_chunk",
        content: "Recorded earlier by the provider.",
        created_at: "2026-07-27T05:38:07.874Z",
      },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({
        createdAt: Date.parse("2026-07-27T05:38:07.874Z"),
        role: "assistant",
        text: "Recorded earlier by the provider.",
      }),
    ]);
  });

  it("reads Grok and Qwen timestamps from ACP update metadata", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1_800_000_000_000,
      update: {
        kind: "agent_message_chunk",
        content: "Grok timestamp.",
        _meta: { agentTimestampMs: 1_785_000_000_100 },
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1_800_000_000_000,
      update: {
        kind: "agent_message_chunk",
        content: " Qwen timestamp.",
        _meta: { timestamp: 1_785_000_000_200 },
      },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({
        createdAt: 1_785_000_000_100,
        role: "assistant",
        text: "Grok timestamp. Qwen timestamp.",
      }),
    ]);
  });

  it("drops Gemini's <session_context> boilerplate user_message_chunk", () => {
    // Gemini re-emits its <session_context> environment block (date/OS/workspace
    // /directory tree) as a user_message_chunk on session/load. It is agent
    // boilerplate, not a user turn — it must never appear in the transcript.
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: { kind: "user_message_chunk", text: "What is this project?" },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: { kind: "agent_message_chunk", content: "It is PwrAgent." },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1002,
      update: {
        kind: "user_message_chunk",
        text: "<session_context>\nThis is the Gemini CLI.\n…\n</session_context>",
      },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({ role: "user", text: "What is this project?" }),
      expect.objectContaining({ role: "assistant", text: "It is PwrAgent." }),
    ]);
    expect(
      replay.messages.some((message) => message.text.includes("session_context")),
    ).toBe(false);
  });

  it("drops ACP <system-reminder> boilerplate user_message_chunk", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        session_update: "user_message_chunk",
        content: { type: "text", text: "Run npm view pwrdrvr" },
      },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        session_update: "user_message_chunk",
        content: {
          type: "text",
          text: "<system-reminder> Auto permission mode is no longer active. Tool approvals and permission checks are back to the current mode. </system-reminder>",
        },
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1002,
      update: {
        session_update: "agent_message_chunk",
        content: { type: "text", text: "pwrdrvr exists on npm." },
      },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({ role: "user", text: "Run npm view pwrdrvr" }),
      expect.objectContaining({
        role: "assistant",
        text: "pwrdrvr exists on npm.",
      }),
    ]);
    expect(
      replay.messages.some((message) => message.text.includes("system-reminder")),
    ).toBe(false);
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

  it("reads Kimi snake_case assistant chunks", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        session_update: "agent_message_chunk",
        content: { type: "text", text: "Kimi text." },
      },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({ role: "assistant", text: "Kimi text." }),
    ]);
    expect(replay.lastAssistantMessage).toBe("Kimi text.");
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

  it("shows a waiting activity for live prompts until the agent responds", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const activeReplay = normalizer.recordUserPrompt({
      sessionId: "session-1",
      prompt: "hello",
      turnId: "pending:session-1",
      receivedAt: 1000,
      waitingForAgent: true,
    });

    expect(activeReplay.entries).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        text: "hello",
      }),
      expect.objectContaining({
        type: "activity",
        id: "agent-waiting:pending:session-1",
        summary: "Waiting for agent response",
        status: "in_progress",
      }),
    ]);

    const respondedReplay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hi." },
      },
    });

    expect(respondedReplay.entries.map((entry) => entry.id)).not.toContain(
      "agent-waiting:pending:session-1",
    );
    expect(respondedReplay.lastAssistantMessage).toBe("Hi.");
  });

  it("removes waiting activity when a provider finishes without a turn id", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.recordUserPrompt({
      sessionId: "session-1",
      prompt: "hello",
      turnId: "pending:session-1",
      receivedAt: 1000,
      waitingForAgent: true,
    });
    const finishedReplay = normalizer.recordTurnFinished();

    expect(finishedReplay.threadStatus).toBe("idle");
    expect(finishedReplay.entries.map((entry) => entry.id)).not.toContain(
      "agent-waiting:pending:session-1",
    );
  });

  it("replaces waiting activity with the provider failure", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.recordUserPrompt({
      sessionId: "session-1",
      prompt: "hello",
      turnId: "pending:session-1",
      receivedAt: 1000,
      waitingForAgent: true,
    });
    const failedReplay = normalizer.recordTurnFailed({
      sessionId: "session-1",
      turnId: "pending:session-1",
      error: "json-rpc error (500): You have exhausted your capacity on this model.",
      receivedAt: 1001,
    });

    expect(failedReplay.entries.map((entry) => entry.id)).not.toContain(
      "agent-waiting:pending:session-1",
    );
    expect(failedReplay.entries).toContainEqual(
      expect.objectContaining({
        type: "activity",
        id: "turn-failed:pending:session-1",
        summary: "Turn failed",
        status: "failed",
      }),
    );
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
      ["assistant:pending:session-1:1000:0", "It is PwrSnap."],
      ["user:pending:session-1:2000", "What is the CWD?"],
      ["assistant:pending:session-1:2000:0", "/repo/project"],
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

  it("merges Kimi snake_case tool call updates into the original activity", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        session_update: "tool_call",
        tool_call_id: "turn-1:tool-1",
        title: "pnpm build",
        status: "in_progress",
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        session_update: "tool_call_update",
        tool_call_id: "turn-1:tool-1",
        title: "pnpm build",
        status: "completed",
        content: { type: "text", text: "Build succeeded" },
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "turn-1:tool-1",
        summary: "pnpm build",
        status: "completed",
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

  it("preserves Grok search arguments across sparse completion updates", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const activeReplay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "grep-1",
        title: "grok",
        kind: "search",
        rawInput: {
          variant: "Grep",
          pattern: "grok",
          glob: "*.{ts,tsx,md,json}",
          head_limit: 20,
        },
      },
    });
    expect(activeReplay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "grep-1",
        summary: "Searching code: grok",
        status: "in_progress",
        details: [
          expect.objectContaining({
            kind: "read",
            label: "Searching code: grok",
          }),
        ],
      }),
    ]);
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "grep-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "found 9 matches",
            },
          },
        ],
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "grep-1",
        summary: "Searched code: grok",
        status: "completed",
        details: [
          expect.objectContaining({
            label: "Searched code: grok",
            command: {
              displayCommand:
                'grep(pattern="grok", glob="*.{ts,tsx,md,json}", head_limit=20)',
              source: "tool",
              output: "found 9 matches",
              exitCode: undefined,
            },
          }),
        ],
      }),
    ]);
  });

  it("renders Grok web search query and sources from raw output", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "ws_grok-search-1",
        title: "Web search:",
        kind: "search",
        status: "in_progress",
        rawInput: {
          variant: "WebSearch",
          backend: true,
          query: "Grok 4.5 image support",
        },
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "ws_grok-search-1",
        title: "Web search:",
        status: "completed",
        rawOutput: {
          action: {
            type: "search",
            query: "Grok 4.5 image support",
            sources: [
              { type: "url", url: "https://x.ai/news/grok-4-5" },
              {
                type: "url",
                title: "Models",
                url: "https://docs.x.ai/developers/models",
              },
            ],
          },
        },
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "ws_grok-search-1",
        summary: "Searched Web",
        status: "completed",
        details: [
          {
            id: "ws_grok-search-1:detail",
            kind: "read",
            label: "Searched Web: Grok 4.5 image support",
            status: "completed",
          },
          {
            id: "ws_grok-search-1:source:1",
            kind: "read",
            label: "https://x.ai/news/grok-4-5",
            url: "https://x.ai/news/grok-4-5",
          },
          {
            id: "ws_grok-search-1:source:2",
            kind: "read",
            label: "Models",
            url: "https://docs.x.ai/developers/models",
          },
        ],
      }),
    ]);
  });

  it.each(["failed", "cancelled"] as const)(
    "uses terminal wording for %s Grok web searches",
    (status) => {
      const normalizer = new AcpSessionReplayNormalizer();

      const replay = normalizer.apply({
        sessionId: "session-1",
        receivedAt: 1000,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: `ws_${status}-search`,
          status,
          rawInput: {
            variant: "WebSearch",
            query: "Grok 4.5 pricing",
          },
        },
      });

      expect(replay.entries).toEqual([
        expect.objectContaining({
          type: "activity",
          summary: "Searched Web",
          status,
          details: [
            expect.objectContaining({
              label: "Searched Web: Grok 4.5 pricing",
              status,
            }),
          ],
        }),
      ]);
    },
  );

  it("renders Grok web fetches as tool-backed reads across sparse updates", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    const url = "https://docs.x.ai/developers/models";

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "web-fetch-1",
        title: "web_fetch",
        rawInput: { url },
        _meta: {
          "x.ai/tool": {
            name: "web_fetch",
            kind: "web_fetch",
          },
        },
      },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "web-fetch-1",
        kind: "fetch",
        title: `Fetch: ${url}`,
        rawInput: {
          variant: "WebFetch",
          url,
        },
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1002,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "web-fetch-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "# Models\n\nGrok 4.5 supports image input.",
            },
          },
        ],
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "web-fetch-1",
        summary: `Fetched ${url}`,
        status: "completed",
        details: [
          expect.objectContaining({
            kind: "read",
            label: `Fetched ${url}`,
            command: {
              displayCommand: `web_fetch(url="${url}")`,
              rawCommand: undefined,
              source: "tool",
              output: "# Models\n\nGrok 4.5 supports image input.",
              exitCode: undefined,
              durationMs: undefined,
              cwd: undefined,
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

  it("strips terminal control sequences from replayed ACP tool output", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "gh-pr-list-1",
        kind: "execute",
        title: "Shell",
        status: "completed",
        content: {
          type: "text",
          text: "\u001b[1;37m{\u001b[0m\u001b[1;34m\"number\"\u001b[0m: 1014}",
        },
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "gh-pr-list-1",
        details: [
          expect.objectContaining({
            command: expect.objectContaining({
              output: "{\"number\": 1014}",
            }),
          }),
        ],
      }),
    ]);
  });

  it("keeps non-shell ACP content with command fields as transcript output", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    const output = "{\"command\":\"npm view pnpm\",\"result\":\"found text\"}";

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "read-file-1",
        kind: "read",
        title: "package.json",
        status: "completed",
        locations: [{ path: "/repo/package.json" }],
        content: {
          type: "text",
          text: output,
        },
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "read-file-1",
        summary: "package.json",
        status: "completed",
        details: [
          expect.objectContaining({
            kind: "read",
            label: "package.json",
            path: "/repo/package.json",
            command: expect.objectContaining({
              displayCommand: "package.json",
              output,
            }),
          }),
        ],
      }),
    ]);
    const activity = replay.entries[0] as
      | { details?: Array<{ command?: { rawCommand?: string } }> }
      | undefined;
    const detail = activity?.details?.[0];
    expect(detail?.command?.rawCommand).toBeUndefined();
  });

  it("extracts Kimi shell commands from raw input and command JSON content", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "2:tool_FepVvUHmSL1YkNrQrdMD9alt",
        kind: "execute",
        title: "Bash",
        status: "pending",
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "2:tool_FepVvUHmSL1YkNrQrdMD9alt",
        kind: "execute",
        title: "Bash",
        status: "in_progress",
        rawInput: { command: "npm view pnpm" },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "{\"command\":\"npm view pnpm\"}",
            },
          },
        ],
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "2:tool_FepVvUHmSL1YkNrQrdMD9alt",
        summary: "npm view pnpm",
        details: [
          expect.objectContaining({
            label: "npm view pnpm",
            command: {
              displayCommand: "npm view pnpm",
              rawCommand: "npm view pnpm",
              output: undefined,
              exitCode: undefined,
            },
          }),
        ],
      }),
    ]);
  });

  it("uses Grok command descriptions while preserving the full command", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    const command = "python3 - <<'PY'\nprint('Grok 4.5')\nPY";
    const description = "Inspect Grok 4.5 model cache entry";

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "run-terminal-1",
        kind: "execute",
        title: `Execute \`${command}\``,
        status: "completed",
        rawInput: {
          variant: "Bash",
          command,
          description,
        },
        content: {
          type: "text",
          text: "Grok 4.5",
        },
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "run-terminal-1",
        summary: description,
        status: "completed",
        details: [
          expect.objectContaining({
            kind: "command",
            label: description,
            command: {
              displayCommand: command,
              rawCommand: command,
              output: "Grok 4.5",
              exitCode: undefined,
            },
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

  it("extracts Grok's session_summary_generated as a topic title", () => {
    // Grok ACP carries the auto-generated thread name in the vendor
    // notification `_x.ai/session_notification`; the inner `update` looks
    // like `{ sessionUpdate: "session_summary_generated", session_summary:
    // "<title>" }`. The acp-client routes that through the same path as
    // session/update, so readAcpTopicTitle must recognize the kind and
    // return the summary verbatim (no "Update topic to: …" parsing).
    expect(
      readAcpTopicTitle({
        sessionUpdate: "session_summary_generated",
        session_summary: "Haiku About Debugging Code in Software",
      }),
    ).toBe("Haiku About Debugging Code in Software");
    // Tolerate camelCase too, since other parts of the codebase normalize
    // to camelCase keys when re-encoding agent updates.
    expect(
      readAcpTopicTitle({
        sessionUpdate: "session_summary_generated",
        sessionSummary: "Refactor toolchain config",
      }),
    ).toBe("Refactor toolchain config");
    // Empty/whitespace summary still bails to undefined so the existing
    // fallback path keeps the seed title (e.g. "ACP session").
    expect(
      readAcpTopicTitle({
        sessionUpdate: "session_summary_generated",
        session_summary: "   ",
      }),
    ).toBeUndefined();
  });

  it("hides the injected managed-review context from the transcript", () => {
    // A finished managed review is handed to the parent thread by prefixing
    // the next prompt with a wrapped context block. Grok echoes every prompt
    // back as a user_message_chunk, so without this the operator sees the
    // whole review artifact rendered as something they supposedly typed.
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "user_message_chunk",
        content: [
          "[PwrAgent review sub-agent results — context for this turn]",
          "",
          '{"findings":[],"overall_correctness":"patch is correct"}',
          "",
          "[End PwrAgent review sub-agent results]",
        ].join("\n"),
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "user_message_chunk",
        content: "Can you summarize the review results for me?",
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        text: "Can you summarize the review results for me?",
      }),
    ]);
  });

  it("keeps user text that shares a chunk with the review context block", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "user_message_chunk",
        content: [
          "[PwrAgent review sub-agent results — context for this turn]",
          "",
          "Review 1:",
          "No blocking findings.",
          "",
          "[End PwrAgent review sub-agent results]",
          "",
          "Summarize that for me.",
        ].join("\n"),
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        text: "Summarize that for me.",
      }),
    ]);
  });

  it("hides a review context block split across two chunks", () => {
    // Grok echoed the whole block in one chunk, but nothing in ACP guarantees
    // that. A chunk carrying only the tail of the block would otherwise miss
    // the open marker and render the artifact remnant plus the close marker.
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "user_message_chunk",
        content:
          "[PwrAgent review sub-agent results — context for this turn]\n\nNo blocking",
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "user_message_chunk",
        content:
          " findings.\n\n[End PwrAgent review sub-agent results]\n\nSummarize.",
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        text: "Summarize.",
      }),
    ]);
  });

  it("extracts the ACP session_info_update title", () => {
    // ACP's own session metadata update (SessionUpdate::SessionInfoUpdate)
    // carries `title` and `updatedAt` and nothing else. Grok Build sends it
    // whenever it settles on a durable session title, which is mid-turn on
    // the first prompt.
    expect(
      readAcpTopicTitle({
        sessionUpdate: "session_info_update",
        title: "Summarize path normalization review findings",
      }),
    ).toBe("Summarize path normalization review findings");
    // A title-less info update (timestamp refresh, or an explicit clear) is
    // still metadata, but it names no topic.
    expect(
      readAcpTopicTitle({
        sessionUpdate: "session_info_update",
        updatedAt: "2026-08-08T19:44:20Z",
      }),
    ).toBeUndefined();
    expect(
      readAcpTopicTitle({ sessionUpdate: "session_info_update", title: null }),
    ).toBeUndefined();
  });

  it("keeps session metadata updates out of a streaming assistant message", () => {
    // Grok Build emits session_info_update and last_turn_summary in the
    // middle of the final assistant stream. Both used to fall through to the
    // unknown-update branch, which dropped an "ACP update: …" activity into
    // the transcript AND cleared the active assistant bubble, splitting the
    // message the operator was watching get written.
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: { sessionUpdate: "agent_message_chunk", content: "Overall: " },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "session_info_update",
        title: "Summarize path normalization review findings",
      },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1002,
      update: {
        sessionUpdate: "last_turn_summary",
        summary: "Summarized the review findings",
        prompt_id: "919afcda-d40d-411e-a729-5a94b0ed94ae",
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1003,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: "the patch has issues.",
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "message",
        role: "assistant",
        text: "Overall: the patch has issues.",
      }),
    ]);
  });

  it("keeps an unrecognized update from splitting a streaming assistant message", () => {
    // Failing to classify an update is not evidence that it ended the
    // assistant's message. session_info_update and last_turn_summary were two
    // instances of this; the next extension kind a provider adds must not tear
    // the reply the operator is watching stream into two bubbles.
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: { sessionUpdate: "agent_message_chunk", content: "Overall: " },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: { sessionUpdate: "some_future_grok_update", detail: "opaque" },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1002,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: "the patch is fine.",
      },
    });

    // The breadcrumb still lands — an unknown kind is worth surfacing — but it
    // sorts after the completed message instead of running through it.
    expect(
      replay.entries.map((entry) =>
        entry.type === "message"
          ? `${entry.id}:${entry.text}`
          : entry.type === "activity"
            ? entry.summary
            : entry.type
      ),
    ).toEqual([
      "assistant:session-1:0:Overall: the patch is fine.",
      "ACP update: some_future_grok_update",
    ]);
  });

  it("ignores transient Grok interaction updates without splitting text", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: { sessionUpdate: "agent_message_chunk", content: "Before " },
    });
    for (const sessionUpdate of [
      "tool_call_delta_chunk",
      "pending_interaction",
      "interaction_resolved",
      "response_completed",
    ]) {
      normalizer.apply({
        sessionId: "session-1",
        receivedAt: 1001,
        update: { sessionUpdate },
      });
    }
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1002,
      update: { sessionUpdate: "agent_message_chunk", content: "after" },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "message",
        role: "assistant",
        text: "Before after",
      }),
    ]);
  });

  it("updates known tool progress without splitting a streaming assistant message", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "background-tool",
        title: "Background check",
        status: "in_progress",
      },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: { sessionUpdate: "agent_message_chunk", content: "Before " },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1002,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "background-tool",
        title: "Background check",
        status: "completed",
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1003,
      update: { sessionUpdate: "agent_message_chunk", content: "after" },
    });

    expect(
      replay.entries.filter((entry) => entry.type === "message"),
    ).toEqual([
      expect.objectContaining({
        id: "assistant:session-1:0",
        role: "assistant",
        text: "Before after",
      }),
    ]);
  });

  it("splits assistant messages around a standalone tool update", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: { sessionUpdate: "agent_message_chunk", content: "Before" },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "standalone-tool",
        title: "Standalone check",
        status: "completed",
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1002,
      update: { sessionUpdate: "agent_message_chunk", content: "After" },
    });

    expect(
      replay.entries.map((entry) =>
        entry.type === "message" ? `${entry.id}:${entry.text}` : entry.type
      ),
    ).toEqual([
      "assistant:session-1:0:Before",
      "activity",
      "assistant:session-1:1:After",
    ]);
  });

  it.each(["plan", "file", "terminal", "turn_started"])(
    "keeps %s as an assistant message boundary",
    (sessionUpdate) => {
      // These kinds really do end the assistant's message. The clear that used
      // to happen up front for everything now lives in each of their branches,
      // so each one needs its own guard: the two tool-call tests above pin only
      // the tool-call pair, and without this dropping any of the other calls is
      // a silent regression.
      const normalizer = new AcpSessionReplayNormalizer();

      normalizer.apply({
        sessionId: "session-1",
        receivedAt: 1000,
        update: { sessionUpdate: "agent_message_chunk", content: "Before" },
      });
      normalizer.apply({
        sessionId: "session-1",
        receivedAt: 1001,
        update: { sessionUpdate, title: "Boundary", status: "completed" },
      });
      const replay = normalizer.apply({
        sessionId: "session-1",
        receivedAt: 1002,
        update: { sessionUpdate: "agent_message_chunk", content: "After" },
      });

      expect(
        replay.entries.flatMap((entry) =>
          entry.type === "message" ? [`${entry.id}:${entry.text}`] : []
        ),
      ).toEqual([
        "assistant:session-1:0:Before",
        "assistant:session-1:1:After",
      ]);
    },
  );

  it("treats Grok turn_completed as an idempotent turn finish", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    normalizer.recordUserPrompt({
      sessionId: "session-1",
      prompt: "Inspect this",
      turnId: "turn-1",
      receivedAt: 1000,
      waitingForAgent: true,
    });

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: { sessionUpdate: "turn_completed" },
    });

    expect(replay.threadStatus).toBe("idle");
    expect(
      replay.entries.some(
        (entry) => entry.type === "activity" && entry.status === "in_progress",
      ),
    ).toBe(false);
  });

  it("keeps Grok last_turn_summary out of the transcript and turn lifecycle", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    normalizer.recordUserPrompt({
      sessionId: "session-1",
      prompt: "Inspect this",
      turnId: "turn-1",
      receivedAt: 1000,
      waitingForAgent: true,
    });

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "last_turn_summary",
        summary: "Inspection complete",
      },
    });

    expect(replay.threadStatus).toBe("active");
    expect(replay.entries).toHaveLength(2);
    expect(
      replay.entries.some(
        (entry) => entry.type === "activity" && entry.summary.startsWith("ACP update:"),
      ),
    ).toBe(false);
  });

  it("records thought chunks as assistant response messages", () => {
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
        id: "assistant:session-1:0",
        role: "assistant",
        text: "Inspecting project files.",
      }),
    ]);
    expect(replay.lastAssistantMessage).toBe("Inspecting project files.");
  });

  it("can hide thought chunks when the backend also sends user-visible messages", () => {
    const normalizer = new AcpSessionReplayNormalizer({
      surfaceThoughtsAsMessages: false,
    });

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "The build completed successfully, so I should report this.",
        },
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Yes, the project builds successfully." },
      },
    });

    expect(replay.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "Yes, the project builds successfully.",
      }),
    ]);
    expect(replay.lastAssistantMessage).toBe(
      "Yes, the project builds successfully.",
    );
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

  it("keeps distinct unknown kinds from colliding on one activity", () => {
    // The breadcrumb is only useful if it names the kind that arrived. Two
    // unrecognized kinds in the same millisecond used to share an id, and
    // upsertActivity merges — so the second one vanished into the first.
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: { sessionUpdate: "some_future_grok_update" },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: { sessionUpdate: "another_future_update" },
    });

    expect(
      replay.entries.flatMap((entry) =>
        entry.type === "activity" ? [entry.summary] : []
      ),
    ).toEqual([
      "ACP update: some_future_grok_update",
      "ACP update: another_future_update",
    ]);
  });

  it("dedupes a replayed unknown update onto one activity", () => {
    // The id still has to collapse a re-applied update, which is what makes it
    // safe to run the same session updates through the normalizer twice.
    const normalizer = new AcpSessionReplayNormalizer();

    const update = {
      sessionId: "session-1",
      receivedAt: 1000,
      update: { sessionUpdate: "some_future_grok_update" },
    };
    normalizer.apply(update);
    const replay = normalizer.apply(update);

    expect(
      replay.entries.flatMap((entry) =>
        entry.type === "activity" ? [entry.summary] : []
      ),
    ).toEqual(["ACP update: some_future_grok_update"]);
  });

  it("omits model change notifications from transcript replay", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "model_changed",
        model_id: "grok-4.5",
        reasoning_effort: "low",
      },
    });

    expect(replay.entries).toEqual([]);
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

  it("silently ignores Grok tool-stream and interaction lifecycle updates", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    for (const [index, update] of [
      {
        sessionUpdate: "tool_call_delta_chunk",
        tool_call_id: "grep-1",
        tool_index: 0,
        name: "grep",
      },
      {
        sessionUpdate: "pending_interaction",
        tool_call_id: "grep-1",
        kind: "permission",
      },
      {
        sessionUpdate: "interaction_resolved",
        tool_call_id: "grep-1",
      },
      {
        sessionUpdate: "response_completed",
        usage: {
          input_tokens: 1_200,
          output_tokens: 50,
          reasoning_tokens: 10,
        },
      },
      {
        sessionUpdate: "model_changed",
        model_id: "grok-4.5",
        reasoning_effort: "high",
      },
      {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-1",
        stop_reason: "end_turn",
        usage: {
          inputTokens: 1_200,
          outputTokens: 50,
          totalTokens: 1_250,
        },
      },
    ].entries()) {
      normalizer.apply({
        sessionId: "session-1",
        receivedAt: 1000 + index,
        update,
      });
    }

    expect(normalizer.replay().entries).toEqual([]);
  });

  it("marks all ACP work entries with their completed turn metadata", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.recordUserPrompt({
      sessionId: "session-1",
      prompt: "Inspect the renderer.",
      turnId: "turn-1",
      receivedAt: 1000,
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1100,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "I will search first." },
      },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1200,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "grep-1",
        kind: "search",
        title: "grep",
        status: "completed",
      },
    });

    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 2500,
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-1",
        stop_reason: "end_turn",
        usage: {
          inputTokens: 1_200,
          outputTokens: 50,
          totalTokens: 1_250,
        },
      },
    });

    expect(replay.entries).toEqual([
      expect.objectContaining({
        id: "user:turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          startedAt: 1000,
          completedAt: 2500,
          durationMs: 1500,
        },
      }),
      expect.objectContaining({
        type: "message",
        phase: "commentary",
        turn: expect.objectContaining({
          id: "turn-1",
          status: "completed",
        }),
      }),
      expect.objectContaining({
        type: "activity",
        id: "grep-1",
        turn: expect.objectContaining({
          id: "turn-1",
          status: "completed",
        }),
      }),
    ]);
  });

  it("splits assistant response messages around tool activity", () => {
    const normalizer = new AcpSessionReplayNormalizer();

    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "does it build?",
        turnId: "turn-1",
      },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "I will inspect package scripts." },
      },
    });
    normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1002,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "cat package.json",
        status: "completed",
      },
    });
    const replay = normalizer.apply({
      sessionId: "session-1",
      receivedAt: 1003,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "The build script is available." },
      },
    });

    expect(
      replay.entries.map((entry) =>
        entry.type === "message" ? `${entry.id}:${entry.text}` : entry.type
      ),
    ).toEqual([
      "user:turn-1:does it build?",
      "assistant:turn-1:0:I will inspect package scripts.",
      "activity",
      "assistant:turn-1:1:The build script is available.",
    ]);
  });

  // End-to-end replay of the captured Grok Build session that produced the
  // bug report: a PwrAgent /review finishes, its artifact is prepended to the
  // operator's follow-up prompt, and Grok streams the summary while emitting
  // session_info_update and last_turn_summary mid-flight.
  describe("captured Grok Build review follow-up turn", () => {
    function replayCapturedParentSession() {
      const normalizer = new AcpSessionReplayNormalizer({
        surfaceThoughtsAsMessages: false,
      });
      let replay = normalizer.replay();
      for (const record of grokReviewSession.parentUpdates) {
        replay = normalizer.apply({
          sessionId: record.params.sessionId,
          receivedAt: record.params._meta.agentTimestampMs,
          update: record.params.update as Record<string, unknown>,
        });
        // The two transient updates below never reach updates.jsonl, so the
        // capture cannot place them; inject them where they landed live —
        // between the assistant's first and last streamed chunks.
        if (record.params.update.sessionUpdate === "agent_message_chunk") {
          replay = normalizer.apply({
            sessionId: record.params.sessionId,
            receivedAt: record.params._meta.agentTimestampMs + 1,
            update: grokReviewSession.liveOnlyUpdates.sessionInfoUpdate,
          });
          replay = normalizer.apply({
            sessionId: record.params.sessionId,
            receivedAt: record.params._meta.agentTimestampMs + 2,
            update: grokReviewSession.liveOnlyUpdates.lastTurnSummary,
          });
        }
      }
      return replay;
    }

    it("shows the operator's prompt without the review artifact", () => {
      const replay = replayCapturedParentSession();
      const userTexts = replay.entries.flatMap((entry) =>
        entry.type === "message" && entry.role === "user" ? [entry.text] : [],
      );

      // "/always-approve on" is the execution-mode control prompt PwrAgent
      // sends over the same session; the renderer materializes it as the
      // permission-transition marker rather than a user bubble.
      expect(userTexts).toEqual([
        "/always-approve on",
        "Can you summarize the review results for me?",
      ]);
      expect(userTexts.join("\n")).not.toContain("PwrAgent review sub-agent");
      expect(userTexts.join("\n")).not.toContain("overall_correctness");
    });

    it("keeps the streamed reply in a single assistant bubble", () => {
      const replay = replayCapturedParentSession();
      const assistantTexts = replay.entries.flatMap((entry) =>
        entry.type === "message" && entry.role === "assistant"
          ? [entry.text]
          : [],
      );

      expect(assistantTexts).toHaveLength(1);
      expect(assistantTexts[0]).toContain("## Review summary");
      // The tail of the reply — everything that used to land in a second
      // bubble once a metadata update reset the active message.
      expect(assistantTexts[0]).toContain("path-separator helper");
    });

    it("leaves no unknown-update noise in the transcript", () => {
      const replay = replayCapturedParentSession();

      expect(
        replay.entries.filter((entry) => entry.id.startsWith("unknown:")),
      ).toEqual([]);
    });

    it("surfaces the session_info_update title as the thread topic", () => {
      expect(
        readAcpTopicTitle(grokReviewSession.liveOnlyUpdates.sessionInfoUpdate),
      ).toBe("Summarize path normalization review findings");
    });
  });
});
