import type {
  AppServerBackendKind,
  AppServerThreadActivityEntry,
  AppServerThreadMessageEntry,
} from "@pwragent/shared/contracts/normalized-app-server";

const COMPLETION_PREFIX = "::browser-complete{title=";
const JSON_STRING_CONTENT = String.raw`(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*`;
const CLOSED_TITLE = new RegExp('^"' + JSON_STRING_CONTENT + '"');
const OPEN_TITLE = new RegExp('^"' + JSON_STRING_CONTENT + String.raw`(?:\\(?:u[\da-fA-F]{0,3})?)?`);

function commentaryText(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): string | undefined {
  if (backend !== "codex" || message.role !== "assistant" || message.phase !== "commentary"
    || message.delivery) {
    return undefined;
  }
  const text = message.text.trimStart();
  if (message.parts?.some((part) => part.type !== "text" || part.text.trim() !== text.trimEnd())) {
    return undefined;
  }
  return text;
}

function readTitle(quotedTitle: string): string | undefined {
  const title = (JSON.parse(quotedTitle) as string).trim();
  return title && !/[\r\n]/.test(title) ? title : undefined;
}

export function codexBrowserCompletionActivity(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): AppServerThreadActivityEntry | undefined {
  const text = commentaryText(message, backend);
  if (!text?.startsWith(COMPLETION_PREFIX)) return undefined;
  const payload = text.slice(COMPLETION_PREFIX.length).trimEnd();
  const quotedTitle = CLOSED_TITLE.exec(payload)?.[0];
  if (!quotedTitle || payload.slice(quotedTitle.length) !== "}") return undefined;
  const title = readTitle(quotedTitle);
  if (!title) return undefined;
  return {
    type: "activity",
    id: message.id,
    createdAt: message.createdAt,
    summary: title,
    status: "completed",
    details: [],
  };
}

export function isPendingCodexBrowserCompletion(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): boolean {
  const text = commentaryText(message, backend);
  if (text === undefined) return false;
  if (COMPLETION_PREFIX.startsWith(text)) return true;
  if (!text.startsWith(COMPLETION_PREFIX)) return false;
  const payload = text.slice(COMPLETION_PREFIX.length);
  const quotedTitle = CLOSED_TITLE.exec(payload)?.[0];
  if (!quotedTitle) return OPEN_TITLE.exec(payload)?.[0] === payload;
  const suffix = payload.slice(quotedTitle.length);
  return (suffix === "" || suffix.trimEnd() === "}") && Boolean(readTitle(quotedTitle));
}
