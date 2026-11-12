import fc from "fast-check";
import { expect, it } from "vitest";
import type { AppServerThreadReplay } from "@pwragent/shared";
import { findAssistantMessageForText } from "../messaging/find-assistant-reply-message";

it("collects the selected reply's turn images once without changing the desktop replay", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 5 }), fc.boolean(), (copies, byItem) => {
    const image = { type: "image" as const, url: "pwrsnap://capture/synthetic/composite" };
    const reply = { id: "final", role: "assistant" as const, text: "Capture ready." };
    const replay: AppServerThreadReplay = {
      entries: [
        { type: "activity", id: "old", summary: "Old capture", status: "completed", turn: { id: "other-turn" },
          details: [{ id: "old", kind: "command", label: "Old", images: [{ type: "image", url: "pwrsnap://capture/other/composite" }] }] },
        { type: "activity", id: "capture", summary: "Capture", status: "completed", turn: { id: "selected-turn" },
          details: [{ id: "capture", kind: "command", label: "Capture", images: Array(copies).fill(image) }] },
        { ...reply, type: "message", turn: { id: "selected-turn" } },
      ],
      messages: [reply],
      pagination: { supportsPagination: false, hasPreviousPage: false },
    };
    const before = JSON.stringify(replay);
    const selected = findAssistantMessageForText(replay, reply.text, byItem ? reply.id : undefined, byItem ? undefined : "selected-turn");
    expect(selected?.parts?.filter((part) => part.type === "image")).toEqual([image]);
    expect(JSON.stringify(replay)).toBe(before);
    expect(replay.messages[0]?.parts).toBeUndefined();
  }));
});
