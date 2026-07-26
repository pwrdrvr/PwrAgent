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

  it("stores ACP rollouts under readable backend directory names", () => {
    const store = new AcpRolloutStore(tempDir);
    const backendId = "acp:grok" as AcpBackendId;

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

    expect(
      fs.existsSync(path.join(tempDir, "acp_grok", "session-1", "rollout.jsonl")),
    ).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "acp_3Agrok"))).toBe(false);
  });

  it("migrates legacy encoded backend rollout history before writing", () => {
    const backendId = "acp:grok" as AcpBackendId;
    const legacyRolloutPath = path.join(
      tempDir,
      "acp_3Agrok",
      "session-1",
      "rollout.jsonl",
    );
    fs.mkdirSync(path.dirname(legacyRolloutPath), { recursive: true });
    fs.writeFileSync(
      legacyRolloutPath,
      `${JSON.stringify({
        type: "update",
        receivedAt: 1000,
        update: {
          kind: "pwragent_user_prompt",
          prompt: "from the old path",
          turnId: "turn-1",
        },
      })}\n`,
      "utf8",
    );

    const store = new AcpRolloutStore(tempDir);
    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        session_update: "agent_message_chunk",
        content: { type: "text", text: "from the new path" },
      },
    });
    const replay = store.readReplay({ backendId, sessionId: "session-1" });

    expect(fs.existsSync(path.join(tempDir, "acp_3Agrok"))).toBe(false);
    expect(
      fs.existsSync(path.join(tempDir, "acp_grok", "session-1", "rollout.jsonl")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tempDir, ".backend-path-layout-v2")),
    ).toBe(true);
    expect(replay.messages.map((message) => message.text)).toEqual([
      "from the old path",
      "from the new path",
    ]);
  });

  it("keeps colliding legacy backend names disjoint after migration", () => {
    const sessionId = "shared-session";
    const writeLegacyRollout = (
      backendDirectory: string,
      prompt: string,
    ): void => {
      const rolloutPath = path.join(
        tempDir,
        backendDirectory,
        sessionId,
        "rollout.jsonl",
      );
      fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
      fs.writeFileSync(
        rolloutPath,
        `${JSON.stringify({
          type: "update",
          receivedAt: 1000,
          update: {
            kind: "pwragent_user_prompt",
            prompt,
            turnId: "turn-1",
          },
        })}\n`,
        "utf8",
      );
    };
    writeLegacyRollout("acp_3Agrok", "grok history");
    writeLegacyRollout("acp_3A3Agrok", "3Agrok history");

    const store = new AcpRolloutStore(tempDir);

    expect(
      store
        .readReplay({
          backendId: "acp:grok" as AcpBackendId,
          sessionId,
        })
        .messages.map((message) => message.text),
    ).toEqual(["grok history"]);
    expect(
      store
        .readReplay({
          backendId: "acp:3Agrok" as AcpBackendId,
          sessionId,
        })
        .messages.map((message) => message.text),
    ).toEqual(["3Agrok history"]);
    expect(fs.existsSync(path.join(tempDir, "acp_grok"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "acp_3Agrok"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "acp_3A3Agrok"))).toBe(false);
  });

  it("does not remigrate new backend directories on later startups", () => {
    const backendId = "acp:3Agrok" as AcpBackendId;
    const firstStore = new AcpRolloutStore(tempDir);
    firstStore.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "belongs to 3Agrok",
        turnId: "turn-1",
      },
    });

    const secondStore = new AcpRolloutStore(tempDir);

    expect(
      secondStore
        .readReplay({ backendId, sessionId: "session-1" })
        .messages.map((message) => message.text),
    ).toEqual(["belongs to 3Agrok"]);
    expect(fs.existsSync(path.join(tempDir, "acp_3Agrok"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "acp_grok"))).toBe(false);
  });

  it("refuses to overwrite an existing migration destination", () => {
    fs.mkdirSync(path.join(tempDir, "acp_3Agrok"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "acp_grok"), { recursive: true });

    expect(() => new AcpRolloutStore(tempDir)).toThrow(
      /both paths exist/,
    );
    expect(fs.existsSync(path.join(tempDir, "acp_3Agrok"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "acp_grok"))).toBe(true);
  });

  it("hides Qwen thought chunks when restoring rollout replay", () => {
    const store = new AcpRolloutStore(tempDir);
    const backendId = "acp:qwen" as AcpBackendId;

    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "I should report this to the user." },
      },
    });
    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Yes, it builds." },
      },
    });

    const replay = store.readReplay({ backendId, sessionId: "session-1" });

    expect(replay.messages).toEqual([
      expect.objectContaining({ role: "assistant", text: "Yes, it builds." }),
    ]);
  });

  it("does not persist model change notifications", () => {
    const store = new AcpRolloutStore(tempDir);
    const backendId = "acp:grok" as AcpBackendId;

    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        sessionUpdate: "model_changed",
        model_id: "grok-4.5",
        reasoning_effort: "low",
      },
    });

    expect(store.readUpdates({ backendId, sessionId: "session-1" })).toEqual([]);
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

  it("does not persist Gemini's <session_context> boilerplate (no reload pollution)", () => {
    const store = new AcpRolloutStore(tempDir);
    const backendId = "acp:gemini" as AcpBackendId;

    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1000,
      update: { kind: "pwragent_user_prompt", prompt: "What is this project?", turnId: "turn-1" },
    });
    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1001,
      update: { kind: "agent_message_chunk", content: { type: "text", text: "It is PwrAgent." } },
    });
    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1002,
      update: { kind: "turn_finished", turnId: "turn-1" },
    });
    // Simulate a reload: session/load replays the environment block as a
    // user_message_chunk. Without the guard this would be appended on every
    // reload, permanently polluting the rollout.
    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 2000,
      update: {
        kind: "user_message_chunk",
        text: "<session_context>\nThis is the Gemini CLI.\n…\n</session_context>",
      },
    });

    const updates = store.readUpdates({ backendId, sessionId: "session-1" });
    expect(
      updates.some(
        (record) =>
          (record.update.kind ?? record.update.session_update) ===
          "user_message_chunk",
      ),
    ).toBe(false);

    const replay = store.readReplay({ backendId, sessionId: "session-1" });
    expect(
      replay.messages.some((message) => message.text.includes("session_context")),
    ).toBe(false);
    expect(replay.messages).toEqual([
      expect.objectContaining({ role: "user", text: "What is this project?" }),
      expect.objectContaining({ role: "assistant", text: "It is PwrAgent." }),
    ]);
  });

  it("does not persist ACP <system-reminder> boilerplate (no reload pollution)", () => {
    const store = new AcpRolloutStore(tempDir);
    const backendId = "acp:kimi" as AcpBackendId;

    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "Run npm view pwrdrvr",
        turnId: "turn-1",
      },
    });
    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 1001,
      update: {
        session_update: "agent_message_chunk",
        content: { type: "text", text: "pwrdrvr exists on npm." },
      },
    });
    store.appendUpdate({
      backendId,
      sessionId: "session-1",
      receivedAt: 2000,
      update: {
        session_update: "user_message_chunk",
        content: {
          type: "text",
          text: "<system-reminder> Auto permission mode is no longer active. Tool approvals and permission checks are back to the current mode. </system-reminder>",
        },
      },
    });

    const updates = store.readUpdates({ backendId, sessionId: "session-1" });
    expect(
      updates.some(
        (record) =>
          (record.update.kind ?? record.update.session_update) ===
          "user_message_chunk",
      ),
    ).toBe(false);

    const replay = store.readReplay({ backendId, sessionId: "session-1" });
    expect(replay.messages.map((message) => message.text)).toEqual([
      "Run npm view pwrdrvr",
      "pwrdrvr exists on npm.",
    ]);
    expect(
      replay.messages.some((message) => message.text.includes("system-reminder")),
    ).toBe(false);
  });
});
