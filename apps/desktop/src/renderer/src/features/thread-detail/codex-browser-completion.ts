import type {
  AppServerBackendKind,
  AppServerThreadActivityEntry,
  AppServerThreadMessageEntry,
} from "@pwragent/shared/contracts/normalized-app-server";

const COMPLETION_PREFIX = '::browser-complete{title="';
const COMPLETION_LINE = /^::browser-complete\{title=("(?:[^"\\\r\n]|\\[^\r\n])*")\}/;

function commentaryText(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): string | undefined {
  if (backend !== "codex" || message.role !== "assistant" || message.phase !== "commentary"
    || message.delivery || !message.text.startsWith(":")) {
    return undefined;
  }
  const text = message.text.trimEnd();
  if (message.parts?.some((part) => part.type !== "text" || part.text.trimEnd() !== text)) {
    return undefined;
  }
  return text;
}

export function codexBrowserCompletionActivity(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): AppServerThreadActivityEntry | undefined {
  const text = commentaryText(message, backend);
  if (!text) return undefined;
  const match = COMPLETION_LINE.exec(text);
  if (!match || match[0] !== text) return undefined;
  try {
    const title = (JSON.parse(match[1]) as string).trim();
    if (!title || /[\r\n]/.test(title)) return undefined;
    return {
      type: "activity",
      id: message.id,
      createdAt: message.createdAt,
      summary: title,
      status: "completed",
      details: [],
    };
  } catch {
    return undefined;
  }
}

export function isPendingCodexBrowserCompletion(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): boolean {
  const text = commentaryText(message, backend);
  if (!text) return false;
  if (COMPLETION_PREFIX.startsWith(text)) return true;
  if (!text.startsWith(COMPLETION_PREFIX) || /[\r\n]/.test(text)) return false;
  // Wait for the settled item. A streamed prefix can still become prose.
  const match = COMPLETION_LINE.exec(text);
  return !match || match[0] === text;
}
