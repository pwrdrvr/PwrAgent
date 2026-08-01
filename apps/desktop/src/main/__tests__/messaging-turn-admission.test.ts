import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MessagingBindingRecord,
  MessagingInboundTextEvent,
} from "@pwragent/messaging-interface";
import {
  MessagingTurnAdmission,
  threadKeyForBinding,
} from "../messaging/core/messaging-turn-admission";

afterEach(() => {
  vi.useRealTimers();
});

describe("MessagingTurnAdmission", () => {
  it("debounces adjacent input events into one bundle", async () => {
    vi.useFakeTimers();
    const binding = buildBinding();
    const onBundleReady = vi.fn();
    const admission = new MessagingTurnAdmission({
      debounceMs: 500,
      now: () => 1000,
      onBundleReady,
    });

    await admission.append({ binding, event: buildTextEvent("first") });
    await vi.advanceTimersByTimeAsync(250);
    await admission.append({ binding, event: buildTextEvent("second") });

    expect(onBundleReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(onBundleReady).toHaveBeenCalledWith(
      expect.objectContaining({
        binding,
        events: [
          expect.objectContaining({ text: "first" }),
          expect.objectContaining({ text: "second" }),
        ],
        threadKey: "codex:thread-1",
      }),
    );
    admission.dispose();
  });

  it("keeps different actors in separate debounce bundles", async () => {
    vi.useFakeTimers();
    const binding = buildBinding();
    const onBundleReady = vi.fn();
    const admission = new MessagingTurnAdmission({
      debounceMs: 500,
      now: () => 1000,
      onBundleReady,
    });

    await admission.append({
      binding,
      event: buildTextEvent("first", "user-1"),
    });
    await admission.append({
      binding,
      event: buildTextEvent("second", "user-2"),
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(onBundleReady).toHaveBeenCalledTimes(2);
    expect(onBundleReady.mock.calls.map(([bundle]) => bundle)).toEqual([
      expect.objectContaining({
        events: [
          expect.objectContaining({
            actor: expect.objectContaining({ platformUserId: "user-1" }),
            text: "first",
          }),
        ],
        threadKey: "codex:thread-1",
      }),
      expect.objectContaining({
        events: [
          expect.objectContaining({
            actor: expect.objectContaining({ platformUserId: "user-2" }),
            text: "second",
          }),
        ],
        threadKey: "codex:thread-1",
      }),
    ]);
    admission.dispose();
  });

  it("tracks queued entries and skips cancelled entries when flushing", () => {
    const binding = buildBinding();
    const admission = new MessagingTurnAdmission({
      debounceMs: 0,
      now: () => 1000,
      onBundleReady: vi.fn(),
    });
    const threadKey = threadKeyForBinding(binding);
    const cancelled = admission.enqueue({
      binding,
      input: [{ type: "text", text: "cancel me" }],
      preview: "cancel me",
      threadKey,
    });
    const next = admission.enqueue({
      binding,
      input: [{ type: "text", text: "send me" }],
      preview: "send me",
      threadKey,
    });

    admission.updateQueuedEntry(cancelled, { status: "cancelled" });

    expect(admission.shiftNextQueued(threadKey)).toMatchObject({
      id: next.id,
      input: [{ type: "text", text: "send me" }],
      status: "queued",
    });
    expect(admission.shiftNextQueued(threadKey)).toBeUndefined();
  });

  it("assigns queued IDs uniquely across independent admissions", () => {
    const binding = buildBinding();
    const buildAdmission = () => new MessagingTurnAdmission({
      debounceMs: 0,
      now: () => 1000,
      onBundleReady: vi.fn(),
    });
    const firstAdmission = buildAdmission();
    const secondAdmission = buildAdmission();
    const enqueue = (admission: MessagingTurnAdmission, text: string) =>
      admission.enqueue({
        binding,
        input: [{ type: "text", text }],
        preview: text,
        threadKey: threadKeyForBinding(binding),
      });

    const first = enqueue(firstAdmission, "from telegram");
    const second = enqueue(secondAdmission, "from discord");

    expect(first.id).not.toBe(second.id);
  });
});

function buildBinding(): MessagingBindingRecord {
  return {
    id: "binding-1",
    authorizedActorIds: ["user-1"],
    backend: "codex",
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    createdAt: 1000,
    threadId: "thread-1",
    updatedAt: 1000,
  };
}

function buildTextEvent(
  text: string,
  platformUserId = "user-1",
): MessagingInboundTextEvent {
  return {
    id: `event:${text}`,
    kind: "text",
    actor: {
      platformUserId,
    },
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    receivedAt: 1000,
    text,
  };
}
