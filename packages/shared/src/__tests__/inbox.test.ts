import { expect, it } from "vitest";
import { deriveInboxState } from "../inbox";

it.each([true, false])("honors explicit seen versions with firstSnapshot=%s", (firstSnapshot) => {
  const thread = { source: "codex" as const, id: "thread", title: "Thread", titleSource: "explicit" as const,
    linkedDirectories: [], updatedAt: 2000 };
  const overlay = { backend: "codex" as const, threadId: "thread", extraLinkedDirectories: [],
    lastSeenAt: 10_000, lastSeenUpdatedAt: 1000 };
  expect(deriveInboxState({ firstSnapshot, isNewThread: true, thread, overlay }))
    .toMatchObject({ inInbox: true, reason: "updated-since-seen" });
  expect(deriveInboxState({ firstSnapshot, isNewThread: true, thread,
    overlay: { ...overlay, lastSeenUpdatedAt: 2000 } }))
    .toMatchObject({ inInbox: false });
});
