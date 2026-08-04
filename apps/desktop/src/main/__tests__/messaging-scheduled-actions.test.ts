import { describe, expect, it } from "vitest";
import type { ScheduledThreadAction } from "@pwragent/shared";
import {
  parseMessagingSchedule,
  resolveScheduledAction,
  scheduledActionDisplayId,
} from "../messaging/core/messaging-scheduled-actions";

function action(id: string): ScheduledThreadAction {
  return {
    id,
    backend: "codex",
    threadId: "thread-1",
    kind: "turn",
    origin: "messaging",
    status: "scheduled",
    scheduledFor: 20_000,
    displayText: "Follow up",
    turn: { input: [{ type: "text", text: "Follow up" }] },
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

describe("messaging scheduled actions", () => {
  it("parses relative schedules without involving the renderer", () => {
    expect(parseMessagingSchedule(["2h", "Follow", "up"], 1_000)).toEqual({
      ok: true,
      scheduledFor: 7_201_000,
      text: "Follow up",
    });
  });

  it("rejects missing messages and past times", () => {
    expect(parseMessagingSchedule(["10m"], 1_000)).toMatchObject({ ok: false });
    expect(parseMessagingSchedule(["1970-01-01T00:00:00Z", "old"], 1_000))
      .toMatchObject({ ok: false });
  });

  it("resolves scoped actions by their displayed stable prefix", () => {
    const scheduled = action("scheduled-action:abcdef12-3456");
    expect(scheduledActionDisplayId(scheduled.id)).toBe("abcdef12");
    expect(resolveScheduledAction([scheduled], "abcdef12")).toEqual({
      ok: true,
      action: scheduled,
    });
  });
});
