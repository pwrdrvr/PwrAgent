import { describe, expect, it } from "vitest";
import { collectThreadImageGallery } from "../thread-image-gallery";

describe("collectThreadImageGallery", () => {
  it("leaves unavailable images out of the lightbox", () => {
    const shown = { type: "image" as const, url: "pwragent-image://file/shown.png" };
    expect(collectThreadImageGallery([
      {
        type: "message",
        id: "reply",
        role: "assistant",
        text: "Here.",
        parts: [
          shown,
          {
            type: "image",
            url: "pwrsnap://capture/cap_1/composite",
            unavailableReason: "PwrSnap image unavailable.",
          },
        ],
      },
    ])).toEqual([shown]);
  });
});
