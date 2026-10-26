import type {
  AppServerBackendKind,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
  NavigationLaunchpadImageAttachment,
} from "@pwragent/shared";

/**
 * The user messages a rewind can go back before: the first prompt of each
 * turn. A provider that reports no turns (ACP) offers every prompt. Codex
 * rewinds by turn, so a prompt without one cannot be a target.
 */
export function collectRewindableMessageIds(
  entries: readonly AppServerThreadEntry[],
  backend: AppServerBackendKind,
): Set<string> {
  const ids = new Set<string>();
  const seenTurnIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.role !== "user") {
      continue;
    }
    const turnId = entry.turn?.id;
    if (turnId) {
      if (seenTurnIds.has(turnId)) {
        continue;
      }
      seenTurnIds.add(turnId);
    } else if (backend === "codex") {
      continue;
    }
    ids.add(entry.id);
  }
  return ids;
}

export type ThreadRewindSummary = {
  /** Turns after the target's own turn, which the rewind also removes. */
  laterTurnCount: number;
  /**
   * Distinct files changed from the target on. Undefined when a collapsed
   * history entry hides its details, so the count cannot be trusted.
   */
  changedFileCount?: number;
};

/** What a rewind to before `messageId` removes, from the loaded transcript. */
export function summarizeThreadRewind(
  entries: readonly AppServerThreadEntry[],
  messageId: string,
  backend: AppServerBackendKind,
): ThreadRewindSummary | undefined {
  const start = entries.findIndex((entry) => entry.id === messageId);
  if (start < 0) {
    return undefined;
  }
  const removed = entries.slice(start);
  const rewindable = collectRewindableMessageIds(removed, backend);
  rewindable.delete(messageId);
  const paths = new Set<string>();
  let countKnown = true;
  for (const entry of removed) {
    if (entry.type !== "activity") {
      continue;
    }
    if (entry.detailsRef && entry.details.length === 0) {
      countKnown = false;
    }
    for (const detail of entry.details) {
      if (detail.path && (detail.fileDiff || detail.kind === "write")) {
        paths.add(detail.path);
      }
    }
  }
  return {
    laterTurnCount: rewindable.size,
    ...(countKnown ? { changedFileCount: paths.size } : {}),
  };
}

export type RewoundPrompt = {
  text: string;
  imageAttachments: NavigationLaunchpadImageAttachment[];
  /** Attachments the composer cannot send again, such as path-less files. */
  droppedAttachmentCount: number;
};

const TRANSCRIPT_LOCAL_IMAGE_PREFIX = "pwragent-image://file/";

/**
 * What a rewind puts back in the composer: the prompt's text, and each image
 * it can send again. A local image the transcript shows through
 * `pwragent-image://file/` goes back as the `localImage` input it came from;
 * the protocol URL stays only as the preview. Inline and web images resend by
 * URL. A peer's image or a file part carries no path the composer can send.
 */
export function rewoundPrompt(message: AppServerThreadMessageEntry): RewoundPrompt {
  const imageAttachments: NavigationLaunchpadImageAttachment[] = [];
  let droppedAttachmentCount = 0;
  (message.parts ?? []).forEach((part, index) => {
    if (part.type === "file") {
      droppedAttachmentCount += 1;
      return;
    }
    if (part.type !== "image") {
      return;
    }
    const id = `rewound:${message.id}:image:${index}`;
    const localPath = transcriptLocalImagePath(part.url);
    if (localPath) {
      const name = part.alt ?? localPath.split(/[\\/]/).pop() ?? "Image";
      imageAttachments.push({
        id,
        name,
        size: 0,
        type: "image/*",
        url: part.url,
        originalInput: { type: "localImage", name, path: localPath },
      });
      return;
    }
    if (/^(?:data:image\/|https?:)/i.test(part.url)) {
      imageAttachments.push({
        id,
        name: part.alt ?? "Image",
        size: 0,
        type: /^data:([^;,]+)/i.exec(part.url)?.[1] ?? "image/*",
        url: part.url,
      });
      return;
    }
    droppedAttachmentCount += 1;
  });
  return { text: message.text, imageAttachments, droppedAttachmentCount };
}

function transcriptLocalImagePath(url: string): string | undefined {
  if (!url.startsWith(TRANSCRIPT_LOCAL_IMAGE_PREFIX)) {
    return undefined;
  }
  try {
    const source = decodeURIComponent(url.slice(TRANSCRIPT_LOCAL_IMAGE_PREFIX.length));
    if (!source.startsWith("file:")) {
      return source || undefined;
    }
    const pathname = decodeURIComponent(new URL(source).pathname);
    // file:///C:/Users/... parses to /C:/Users/...
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return undefined;
  }
}
