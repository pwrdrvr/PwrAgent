import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpRolloutStore } from "../acp/acp-rollout-store";
import type { AcpBackendId } from "@pwragent/shared";

describe("AcpRolloutStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-acp-rollout-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("restores Kimi ACP transcript history from append-only JSONL", () => {
    const store = new AcpRolloutStore(tempDir);
    const backendId = "acp:kimi" as AcpBackendId;

    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "hello",
        turnId: "turn-1",
      },
    });
    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        session_update: "agent_message_chunk",
        content: { type: "text", text: "Hi" },
      },
    });

    const replay = store.readReplay({ backendId, sessionId: "session-1" });

    expect(replay.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({ role: "assistant", text: "Hi" }),
    ]);
  });

  it("coalesces unchanged tool updates before writing rollout records", () => {
    const store = new AcpRolloutStore(tempDir);
    const backendId = "acp:kimi" as AcpBackendId;

    for (let index = 0; index < 5; index += 1) {
      store.appendUpdate({
        backendId,
        sessionId: "session-1",
        receivedAt: 1000 + index,
        update: {
          session_update: "tool_call_update",
          tool_call_id: "turn-1:tool-1",
          title: "pnpm build",
          status: "in_progress",
        },
      });
    }

    expect(store.readUpdates({ backendId, sessionId: "session-1" })).toHaveLength(1);
  });

  it("coalesces adjacent streaming text chunks before writing rollout records", () => {
    const store = new AcpRolloutStore(tempDir);
    const backendId = "acp:kimi" as AcpBackendId;

    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "hello",
        turnId: "turn-1",
      },
    });
    for (const text of ["Kim", "i says", " hi"]) {
      store.appendUpdate({
        backendId,
        sessionId: "session-1",
        receivedAt: 1001,
        update: {
          session_update: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    }
    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1002,
      update: {
        kind: "turn_finished",
        turnId: "turn-1",
      },
    });

    const records = store.readUpdates({ backendId, sessionId: "session-1" });

    expect(records.map((record) => record.update)).toEqual([
      expect.objectContaining({ kind: "pwragent_user_prompt" }),
      expect.objectContaining({
        session_update: "agent_message_chunk",
        content: { type: "text", text: "Kimi says hi" },
      }),
      expect.objectContaining({ kind: "turn_finished" }),
    ]);
  });
});
