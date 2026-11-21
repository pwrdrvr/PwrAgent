import fc from "fast-check";
import { expect, it } from "vitest";
import type { AppServerThreadEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { collectThreadImageGallery } from "../thread-image-gallery";

it("keeps distinct retained images in transcript order even when their source paths repeat", () => {
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 12 }),
    (paths) => {
      // Each message retains its own image, even when it links to a path
      // used by an earlier message. Add one guaranteed reuse of a path.
      const images = [...paths, paths[0]].map((path, index) => ({
        type: "image" as const,
        url: `pwragent-image://file/retained-${index}.png`,
        sourceUrl: `file:///tmp/screenshot-${path}.png`,
      }));
      const entries: AppServerThreadEntry[] = images.map((image, index) => ({
        type: "message",
        id: `reply-${index}`,
        role: "assistant",
        text: "",
        parts: [image],
      }));
      entries.push({
        type: "message",
        id: "repeat",
        role: "assistant",
        text: "",
        parts: [{ ...images[0] }],
      });

      expect(collectThreadImageGallery(entries)).toEqual(images);
    },
  ));
});
