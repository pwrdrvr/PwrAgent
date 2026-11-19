import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { privateReplySourceFromBinding, readOptionalPositiveInteger, readPdfToolPageNumbers, sanitizeMessagingChildTitle } from "../messaging/core/messaging-agent-tool-helpers";

describe("Agent messaging tool helpers", () => {
  it("keeps private-reply routing snapshots independent from later source mutation", () => {
    fc.assert(fc.property(fc.constantFrom("telegram", "discord"), fc.string(), fc.array(fc.string(), { maxLength: 4 }), (channel, title, actors) => {
      const binding: MessagingBindingRecord = { id: "fixture", backend: "codex", threadId: "fixture-thread",
        channel: { channel, conversation: { id: "fixture-conversation", kind: "channel", title } },
        authorizedActorIds: [...actors], routingState: { opaque: { fixture: [title] } }, createdAt: 1, updatedAt: 2 };
      const expected = structuredClone(binding);
      const snapshot = privateReplySourceFromBinding(binding);
      binding.channel.conversation.title = "Changed after snapshot";
      binding.authorizedActorIds.push("another-actor");
      binding.routingState!.opaque = { fixture: ["changed"] };
      expect(snapshot).toMatchObject(expected);
    }));
  });

  it("accepts only nonempty PDF page sequences of positive safe integers", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 5 }), fc.boolean(), (pages, invalid) => {
      const input = invalid ? [...pages, 0] : pages;
      expect(readPdfToolPageNumbers(input)).toEqual(invalid ? undefined : pages);
      expect(readOptionalPositiveInteger(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
      expect(readPdfToolPageNumbers([])).toBeUndefined();
    }));
  });

  it("bounds child titles by code point and normalizes blank titles", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("a", "界", "🙂", " ", "\n"), { minLength: 110, maxLength: 140 }), units => {
      const title = sanitizeMessagingChildTitle("🙂".repeat(105) + units.join(""));
      expect(Array.from(title).length).toBeLessThanOrEqual(100);
      expect(title).not.toBe("");
      expect(title.startsWith(" ")).toBe(false);
      expect(title).not.toMatch(/\s{2,}|[\n\r]/u);
      expect(sanitizeMessagingChildTitle(" \n ")).toBe("PwrAgent thread");
    }));
  });
});
