import type {
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
} from "@pwragnt/shared";

export type TranscriptRenderItem =
  | {
      type: "entry";
      entry: AppServerThreadEntry;
    }
  | {
      type: "commentaryGroup";
      id: string;
      hiddenMessages: AppServerThreadMessageEntry[];
    };

export function buildTranscriptRenderItems(params: {
  entries: AppServerThreadEntry[];
  activeMessageId?: string;
}): TranscriptRenderItem[] {
  if (params.activeMessageId) {
    return params.entries.map((entry) => ({ type: "entry", entry }));
  }

  const commentaryMessages = params.entries.filter(isAssistantCommentaryMessage);
  if (commentaryMessages.length === 0) {
    return params.entries.map((entry) => ({ type: "entry", entry }));
  }

  const hiddenMessages = commentaryMessages;

  if (hiddenMessages.length === 0) {
    return params.entries.map((entry) => ({ type: "entry", entry }));
  }

  const hiddenIds = new Set(hiddenMessages.map((message) => message.id));
  const hiddenGroupId = buildCommentaryGroupId(hiddenMessages);
  const items: TranscriptRenderItem[] = [];
  let insertedHiddenGroup = false;

  for (const entry of params.entries) {
    if (isAssistantCommentaryMessage(entry) && hiddenIds.has(entry.id)) {
      if (!insertedHiddenGroup) {
        items.push({
          type: "commentaryGroup",
          id: hiddenGroupId,
          hiddenMessages,
        });
        insertedHiddenGroup = true;
      }
      continue;
    }

    items.push({ type: "entry", entry });
  }

  return items;
}

function isAssistantCommentaryMessage(
  entry: AppServerThreadEntry | undefined
): entry is AppServerThreadMessageEntry {
  return (
    entry?.type === "message" &&
    entry.role === "assistant" &&
    entry.phase === "commentary"
  );
}

function buildCommentaryGroupId(
  hiddenMessages: AppServerThreadMessageEntry[]
): string {
  const firstId = hiddenMessages[0]?.id ?? "start";
  const lastId = hiddenMessages[hiddenMessages.length - 1]?.id ?? "end";
  return `commentary:${firstId}:${lastId}:complete`;
}
