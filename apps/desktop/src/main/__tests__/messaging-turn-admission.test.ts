import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
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

  it("separates identical thread ids owned by different instances", () => {
    const local = buildBinding();
    const remote: MessagingBindingRecord = {
      ...buildBinding(),
      id: "binding-remote",
      federatedThread: {
        backend: "codex",
        target: { scope: "remote", instanceId: "client_one" },
        threadId: "thread-1",
      },
    };

    expect(threadKeyForBinding(local)).toBe("codex:thread-1");
    expect(threadKeyForBinding(remote)).toBe(
      "remote:client_one:codex:thread-1",
    );
  });

  it("keeps each debounce bundle on the conversation and connection that supplied its input", async () => {
    vi.useFakeTimers();
    const onBundleReady = vi.fn();
    const admission = new MessagingTurnAdmission({ debounceMs: 500, onBundleReady });
    const routes = [undefined, "mc_" + "1".repeat(32), "mc_" + "2".repeat(32)]
      .flatMap((connectionId) => ["shared", "private"].map((id) => ({ connectionId, id })));
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...routes), { maxLength: 6 }), async (interleaving) => {
      onBundleReady.mockClear();
      for (const [index, { connectionId, id }] of [...interleaving, ...routes].entries()) {
        const base = buildBinding();
        const channel = { ...base.channel, connectionId, conversation: { ...base.channel.conversation, id } };
        await admission.append({
          binding: { ...base, channel, id: channel.conversation.id },
          event: { ...buildTextEvent(`fixture-${index}`), channel },
        });
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(onBundleReady).toHaveBeenCalledTimes(routes.length);
      for (const [bundle] of onBundleReady.mock.calls) {
        expect(bundle.events.every((event: MessagingInboundTextEvent) =>
          event.channel.conversation.id === bundle.binding.channel.conversation.id
          && event.channel.connectionId === bundle.binding.channel.connectionId)).toBe(true);
      }
    }));
    admission.dispose();
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
