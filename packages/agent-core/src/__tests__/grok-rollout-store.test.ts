import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppServerSessionState } from "../app-server/session-state.js";
import { GrokRolloutStore } from "../persistence/grok-rollout-store.js";
import { createTemporaryTestDirectory } from "../testing/test-harness.js";

describe("GrokRolloutStore", () => {
  it("round-trips thread metadata, rollout events, and provider continuity", async () => {
    const temp = await createTemporaryTestDirectory();

    try {
      const store = new GrokRolloutStore(temp.path);
      const state = new AppServerSessionState({ store });
      state.createThread({
        threadId: "thread-1",
        model: "grok-4.20-fast",
      });
      state.setThreadName("thread-1", "Bug bash");
      state.appendInput("thread-1", [{ type: "text", text: "Ship Unit 3" }]);
      state.appendAssistant("thread-1", "Done.");
      state.upsertItem("thread-1", {
        id: "tool-7",
        type: "execCommand",
        status: "completed",
        command: "rg --files",
        commandAction: "search",
      });
      state.setPreviousResponseId("thread-1", "resp_1");

      const hydrated = new AppServerSessionState({
        store: new GrokRolloutStore(temp.path),
      });

      expect(hydrated.readThread("thread-1")).toEqual({
        threadId: "thread-1",
        thread: expect.objectContaining({
          threadId: "thread-1",
          threadName: "Bug bash",
          model: "grok-4.20-fast",
        }),
        messages: [
          { role: "user", text: "Ship Unit 3" },
          { role: "assistant", text: "Done." },
        ],
        items: [
          {
            id: expect.any(String),
            type: "userMessage",
            status: "completed",
            role: "user",
            text: "Ship Unit 3",
          },
          {
            id: expect.any(String),
            type: "agentMessage",
            status: "completed",
            role: "assistant",
            text: "Done.",
          },
          {
            id: "tool-7",
            type: "execCommand",
            status: "completed",
            command: "rg --files",
            commandAction: "search",
          },
        ],
        lastUserMessage: "Ship Unit 3",
        lastAssistantMessage: "Done.",
      });
      expect(hydrated.getPreviousResponseId("thread-1")).toBe("resp_1");

      const threadToml = await fs.readFile(
        path.join(temp.path, "threads/thread-1/thread.toml"),
        "utf8",
      );
      const rolloutJsonl = await fs.readFile(
        path.join(temp.path, "threads/thread-1/rollout.jsonl"),
        "utf8",
      );

      expect(threadToml).toContain('thread_id = "thread-1"');
      expect(threadToml).toContain('previous_response_id = "resp_1"');
      expect(rolloutJsonl).toContain('"type":"message"');
      expect(rolloutJsonl).toContain("Ship Unit 3");
      expect(rolloutJsonl).toContain('"command":"rg --files"');
    } finally {
      await temp.cleanup();
    }
  });

  it("fails with a path-specific error for malformed rollout data", async () => {
    const temp = await createTemporaryTestDirectory();
    const threadDir = path.join(temp.path, "threads/thread-1");
    const threadTomlPath = path.join(threadDir, "thread.toml");
    const rolloutPath = path.join(threadDir, "rollout.jsonl");

    try {
      await fs.mkdir(threadDir, { recursive: true });
      await fs.writeFile(
        threadTomlPath,
        [
          'thread_id = "thread-1"',
          "created_at = 1",
          "updated_at = 2",
          "",
        ].join("\n"),
      );
      await fs.writeFile(rolloutPath, "{not-json}\n");

      expect(() => new GrokRolloutStore(temp.path).load()).toThrow(
        `Invalid JSONL record 1 in ${rolloutPath}`,
      );
    } finally {
      await temp.cleanup();
    }
  });

  it("preserves repeated tool ids from separate turns after hydration", async () => {
    const temp = await createTemporaryTestDirectory();

    try {
      const state = new AppServerSessionState({
        store: new GrokRolloutStore(temp.path),
      });
      state.createThread({
        threadId: "thread-1",
      });
      state.appendInput("thread-1", [{ type: "text", text: "First turn" }]);
      state.upsertItem("thread-1", {
        id: "tool-1",
        type: "dynamicToolCall",
        status: "completed",
        text: "first result",
      });
      state.appendAssistant("thread-1", "Done.");
      state.appendInput("thread-1", [{ type: "text", text: "Second turn" }]);
      state.upsertItem("thread-1", {
        id: "tool-1",
        type: "dynamicToolCall",
        status: "completed",
        text: "second result",
      });

      const hydrated = new AppServerSessionState({
        store: new GrokRolloutStore(temp.path),
      });

      expect(hydrated.readThread("thread-1").items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "tool-1",
            text: "first result",
          }),
          expect.objectContaining({
            id: "tool-1#2",
            text: "second result",
          }),
        ]),
      );
    } finally {
      await temp.cleanup();
    }
  });
});
