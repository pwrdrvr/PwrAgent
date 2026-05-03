import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MessagingBindingRecord,
  MessagingInboundTextEvent,
} from "@pwragnt/shared";
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

function buildTextEvent(text: string): MessagingInboundTextEvent {
  return {
    id: `event:${text}`,
    kind: "text",
    actor: {
      platformUserId: "user-1",
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
