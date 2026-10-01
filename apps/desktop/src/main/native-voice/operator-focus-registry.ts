import type { WebContents } from "electron";
import {
  isAppServerBackendKind,
  OPERATOR_FOCUS_VIEWS,
  type OperatorFocusSnapshot,
} from "@pwragent/shared";

/**
 * Latest published operator focus, per local main window.
 *
 * In memory only: focus changes on every thread click, and nothing about it
 * needs to survive a restart. Reads serve the most recent publish, and a
 * window republishes when it gains focus, so the answer tracks the window the
 * operator last used rather than the one that changed last in the background.
 */
type Entry = { focus: OperatorFocusSnapshot; webContents: WebContents; receivedAt: number };

const entries = new Map<number, Entry>();

export function publishOperatorFocus(params: {
  focus: OperatorFocusSnapshot;
  webContents: WebContents;
  now?: number;
}): void {
  if (params.webContents.isDestroyed()) return;
  const id = params.webContents.id;
  if (!entries.has(id)) params.webContents.once("destroyed", () => { entries.delete(id); });
  entries.set(id, { focus: params.focus, webContents: params.webContents, receivedAt: params.now ?? Date.now() });
}

export function readOperatorFocus(): { focus: OperatorFocusSnapshot; receivedAt: number } | undefined {
  let latest: Entry | undefined;
  for (const [id, entry] of entries) {
    if (entry.webContents.isDestroyed()) {
      entries.delete(id);
      continue;
    }
    if (!latest || entry.receivedAt > latest.receivedAt) latest = entry;
  }
  return latest ? { focus: latest.focus, receivedAt: latest.receivedAt } : undefined;
}

/** Test seam: drop every published focus. */
export function resetOperatorFocusRegistry(): void {
  entries.clear();
}

const MAX_TEXT = 500;

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}

/**
 * Validated rather than trusted: this lands in a tool result that a model
 * reads as the operator's screen.
 */
export function isOperatorFocusSnapshot(value: unknown): value is OperatorFocusSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const focus = value as Record<string, unknown>;
  if (!OPERATOR_FOCUS_VIEWS.includes(focus.view as OperatorFocusSnapshot["view"])) return false;
  if (focus.lens !== undefined && !boundedString(focus.lens)) return false;
  return (focus.thread === undefined || isFocusThread(focus.thread))
    && (focus.launchpad === undefined || isFocusLaunchpad(focus.launchpad));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || boundedString(value);
}

function isFocusThread(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.backend === "string" && isAppServerBackendKind(value.backend)
    && boundedString(value.threadId)
    && typeof value.title === "string" && value.title.length <= MAX_TEXT
    && optionalString(value.instanceId)
    && optionalString(value.instanceLabel);
}

function isFocusLaunchpad(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.backend === "string" && isAppServerBackendKind(value.backend)
    && boundedString(value.projectKey)
    && typeof value.projectLabel === "string" && value.projectLabel.length <= MAX_TEXT
    && optionalString(value.instanceId)
    && optionalString(value.model)
    && optionalString(value.reasoningEffort)
    && optionalString(value.executionMode)
    && optionalString(value.workMode);
}
