import type { ReadQueuedTurnResponse } from "@pwragent/shared";
import type { ComposerQueuedTurnSnapshot } from "./useComposerDraftStore";

/** Convert only authoritative input. Display previews are never editable content. */
export function restoreQueuedMessage(
  queued: ComposerQueuedTurnSnapshot,
  content: ReadQueuedTurnResponse,
): ComposerQueuedTurnSnapshot {
  let imageIndex = 0;
  return {
    ...queued,
    input: content.input,
    text: content.input
      .flatMap((item) => item.type === "text" ? [item.text] : [])
      .join("\n"),
    imageAttachments: content.input.flatMap((item, index) => {
      if (item.type !== "image" && item.type !== "localImage") return [];
      const preview = content.imageParts?.[imageIndex++];
      return [{
        id: `${queued.id}:image:${index}`,
        name: item.name ?? "Image",
        size: 0,
        type: "image/*",
        url: item.type === "image" ? item.url : preview?.url ?? item.path,
        ...(item.type === "localImage" ? { originalInput: item } : {}),
      }];
    }),
    fileAttachments: content.input.flatMap((item, index) =>
      item.type === "file" || item.type === "localFile"
        ? [{
            id: `${queued.id}:file:${index}`,
            label: item.name ?? "File",
            path: item.type === "localFile" ? item.path : "",
            originalInput: item,
          }]
        : [],
    ),
  };
}
