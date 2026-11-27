import { expect, it } from "vitest";
import { restoreQueuedMessage } from "../queued-message-content";

it.each([undefined, { mode: "plan" } as const])(
  "restores the owner's turn mode independently of the message text (%j)",
  (collaborationMode) => {
    const restored = restoreQueuedMessage({
      id: "queue-1", text: "Short preview", imageAttachments: [], fileAttachments: [],
    }, {
      queueEntryId: "queue-1", contentHash: "hash", collaborationMode,
      input: [{ type: "text", text: "next step" }],
    });
    expect(restored.text).toBe("next step");
    expect(restored.collaborationMode).toEqual(collaborationMode);
  },
);
