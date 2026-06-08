/**
 * Unit coverage for the Phase-B kit Codex adapter's event mapping
 * (`PWRAGENT_CODEX_KIT=1` path). Proves the kit's neutral
 * `NormalizedThreadEvent`s convert to the `AppServerNotification` shapes the
 * registry + renderer consume live — without spawning Codex.
 */
import { describe, expect, it } from "vitest";
import type { NormalizedThreadEvent } from "@pwrdrvr/agent-core";
import {
  codexEventToNotifications,
  isCodexKitFlagEnabled,
} from "../codex-app-server/codex-kit-adapter";

describe("isCodexKitFlagEnabled", () => {
  it("is on only for an exact '1'", () => {
    expect(isCodexKitFlagEnabled({ PWRAGENT_CODEX_KIT: "1" })).toBe(true);
    expect(isCodexKitFlagEnabled({ PWRAGENT_CODEX_KIT: " 1 " })).toBe(true);
    expect(isCodexKitFlagEnabled({ PWRAGENT_CODEX_KIT: "0" })).toBe(false);
    expect(isCodexKitFlagEnabled({ PWRAGENT_CODEX_KIT: "true" })).toBe(false);
    expect(isCodexKitFlagEnabled({})).toBe(false);
  });
});

describe("codexEventToNotifications", () => {
  it("maps the turn lifecycle + streaming message", () => {
    const events: NormalizedThreadEvent[] = [
      { kind: "turn_started", threadId: "t1", turnId: "u1" },
      {
        kind: "agent_message_delta",
        threadId: "t1",
        turnId: "u1",
        itemId: "i1",
        delta: "Hello",
      },
      {
        kind: "agent_message",
        threadId: "t1",
        turnId: "u1",
        message: { id: "i1", role: "assistant", text: "Hello world" },
      },
      { kind: "turn_completed", threadId: "t1", turnId: "u1", status: "completed" },
    ];

    const methods = events.flatMap((e) =>
      codexEventToNotifications(e).map((n) => n.method),
    );
    expect(methods).toEqual([
      "turn/started",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ]);
  });

  it("carries the streaming delta through verbatim", () => {
    const [n] = codexEventToNotifications({
      kind: "agent_message_delta",
      threadId: "t1",
      turnId: "u1",
      itemId: "i1",
      delta: "chunk",
    });
    expect(n).toMatchObject({
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "u1", itemId: "i1", delta: "chunk" },
    });
  });

  it("maps command tool calls to commandExecution items", () => {
    const [started] = codexEventToNotifications({
      kind: "tool_call",
      threadId: "t1",
      turnId: "u1",
      toolCall: {
        id: "c1",
        name: "shell",
        kind: "command",
        label: "ls",
        status: "in_progress",
      },
    });
    expect(started).toMatchObject({
      method: "item/started",
      params: { item: { id: "c1", type: "commandExecution" } },
    });
  });

  it("maps errors to turn/failed with the message", () => {
    const [n] = codexEventToNotifications({
      kind: "error",
      threadId: "t1",
      turnId: "u1",
      message: "boom",
    });
    expect(n).toMatchObject({
      method: "turn/failed",
      params: { threadId: "t1", turnId: "u1", turn: { error: { message: "boom" } } },
    });
  });

  it("ignores events with no live-stream notification (e.g. reasoning_delta)", () => {
    expect(
      codexEventToNotifications({
        kind: "reasoning_delta",
        threadId: "t1",
        turnId: "u1",
        itemId: "i1",
        delta: "thinking",
      }),
    ).toEqual([]);
  });
});
