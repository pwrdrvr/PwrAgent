import { describe, expect, it } from "vitest";
import type {
  AppServerThreadEntry,
  ThreadMessagingBindingTransition,
} from "@pwragent/shared";
import {
  MESSAGING_BINDING_TRANSITION_ENTRY_PREFIX,
  buildMessagingBindingTransitionActivityEntries,
  injectMessagingBindingTransitions,
  isMessagingBindingTransitionEntry,
} from "../messaging-binding-transition-entries";

const bound: ThreadMessagingBindingTransition = {
  id: "bind-1",
  action: "bound",
  bindingId: "binding-1",
  platform: "telegram",
  conversationKind: "topic",
  conversationTitle: "PwrDrvr/Topic",
  parentTitle: "PwrDrvr",
  occurredAt: 1_000,
};

const unbound: ThreadMessagingBindingTransition = {
  id: "unbind-1",
  action: "unbound",
  bindingId: "binding-1",
  platform: "discord",
  conversationKind: "channel",
  conversationTitle: "release",
  parentTitle: "PwrAgent",
  occurredAt: 2_000,
};

describe("messaging-binding-transition-entries", () => {
  it("builds synthetic activity entries with prefixed ids", () => {
    const entries = buildMessagingBindingTransitionActivityEntries([
      bound,
      unbound,
    ]);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.type).toBe("activity");
      expect(entry.id.startsWith(MESSAGING_BINDING_TRANSITION_ENTRY_PREFIX))
        .toBe(true);
      expect(isMessagingBindingTransitionEntry(entry)).toBe(true);
    }
  });

  it("summarizes bound and unbound channel transitions", () => {
    const [boundEntry, unboundEntry] =
      buildMessagingBindingTransitionActivityEntries([bound, unbound]);

    expect(boundEntry.summary).toBe(
      "Channel bound: Telegram - PwrDrvr / PwrDrvr/Topic",
    );
    expect(unboundEntry.summary).toBe(
      "Channel unbound: Discord - PwrAgent / release",
    );
  });

  it("returns the original entries array when transitions is empty", () => {
    const original: AppServerThreadEntry[] = [];
    expect(injectMessagingBindingTransitions(original, undefined)).toBe(original);
    expect(injectMessagingBindingTransitions(original, [])).toBe(original);
  });

  it("merges and orders synthetic entries by occurredAt", () => {
    const existing: AppServerThreadEntry[] = [
      {
        type: "message",
        id: "msg-1",
        role: "user",
        phase: "final",
        createdAt: 500,
        text: "hi",
      },
      {
        type: "message",
        id: "msg-2",
        role: "assistant",
        phase: "final",
        createdAt: 2_500,
        text: "hello",
      },
    ];

    const merged = injectMessagingBindingTransitions(existing, [unbound, bound]);
    expect(merged.map((entry) => entry.id)).toEqual([
      "msg-1",
      `${MESSAGING_BINDING_TRANSITION_ENTRY_PREFIX}${bound.id}`,
      `${MESSAGING_BINDING_TRANSITION_ENTRY_PREFIX}${unbound.id}`,
      "msg-2",
    ]);
  });
});
