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

function collectTextFragments(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextFragments(entry));
  }

  const record = value as Record<string, unknown>;
  const directText = ["text", "content", "message", "input"].flatMap((key) =>
    typeof record[key] === "string" ? [record[key] as string] : []
  );
  const nestedText = ["content", "parts", "input", "item"].flatMap((key) =>
    typeof record[key] === "string" ? [] : collectTextFragments(record[key])
  );
  return [...directText, ...nestedText];
}

function collectImageUrls(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectImageUrls(entry));
  }

  const record = value as Record<string, unknown>;
  const directImages = Object.entries(record).flatMap(([key, entry]) =>
    typeof entry === "string" &&
    (key === "url" ||
      key === "image_url" ||
      key === "imageUrl" ||
      key === "image" ||
      key === "src" ||
      entry.startsWith("data:image/"))
      ? [entry]
      : []
  );
  const nestedImages = Object.values(record).flatMap((entry) =>
    typeof entry === "string" ? [] : collectImageUrls(entry)
  );
  return [...directImages, ...nestedImages];
}

export function notificationIncludesDraftContent(
  params: unknown,
  draft: Pick<ComposerQueuedTurnSnapshot, "text" | "imageAttachments">,
): boolean {
  const preview = draft.text.trim();
  if (preview) {
    return collectTextFragments(params).some((fragment) =>
      fragment.includes(preview)
    );
  }

  const attachmentUrls = draft.imageAttachments.map(
    (attachment) => attachment.url,
  );
  if (attachmentUrls.length === 0) {
    return false;
  }

  const notificationImageUrls = new Set(collectImageUrls(params));
  return attachmentUrls.every((url) => notificationImageUrls.has(url));
}
