/**
 * Keyboard shortcuts for thread actions: which action a keydown asks for, and
 * which threads it acts on.
 *
 * The target rule is the one the sidebar's context menu already follows:
 *   - Focus on a sidebar row acts on that row, or on the whole selection when
 *     the row is part of a multi-selection.
 *   - Anywhere else, the action applies to the open thread.
 * So ⇧⌘P in the composer pins the thread being read, and ⇧⌘P after
 * shift-clicking three rows pins all three.
 */
import type { BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import type { KeyEventLike, KeybindingActionId } from "../../../../shared/keybindings";
import { isEditableTarget } from "../../lib/keyboard-accel";
import { keydownMatchesAction } from "../../lib/keybindings-store";

export const THREAD_HOTKEY_ACTIONS = [
  "threads.rename",
  "threads.archive",
  "threads.toggle_pin",
  "threads.toggle_keep_at_top",
  "threads.toggle_unread",
  "threads.lock",
  "threads.copy_link",
] as const satisfies readonly KeybindingActionId[];

export type ThreadHotkeyAction = (typeof THREAD_HOTKEY_ACTIONS)[number];

/**
 * Rows carry their thread's identity key here (`ThreadRow` writes it), so
 * focus can name its row.
 */
export const THREAD_ROW_KEY_ATTRIBUTE = "data-thread-key";

/**
 * Where a keydown came from, as far as thread shortcuts care.
 *   "blocked" — never act: a dialog or menu holds focus, or the field is one
 *               the shortcut would take keys from (the rename input, search).
 *   "field"   — the composer: shortcuts that cannot edit text still work.
 *   "free"    — anywhere else.
 */
export function threadHotkeyFocusContext(event: KeyboardEvent): "blocked" | "field" | "free" {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("[aria-modal='true'], [role='menu'], [role='dialog'], [role='listbox']")) {
    return "blocked";
  }
  if (!isEditableTarget(event)) {
    return "free";
  }
  return target?.closest(".composer") ? "field" : "blocked";
}

/** The thread action a keydown presses, or `null`. */
export function matchThreadHotkey(event: KeyboardEvent): ThreadHotkeyAction | null {
  if (event.defaultPrevented || event.repeat || event.isComposing) {
    return null;
  }
  const context = threadHotkeyFocusContext(event);
  if (context === "blocked") {
    return null;
  }
  for (const actionId of THREAD_HOTKEY_ACTIONS) {
    if (keydownMatchesAction(event, actionId, context === "field")) {
      return actionId;
    }
  }
  return null;
}

/**
 * Move Up / Move Down for the pinned row or directory header that has focus.
 * They belong to the focused row only, so the row's own keydown handler reads
 * them rather than the window dispatcher.
 */
export function matchMoveHotkey(event: KeyEventLike): "up" | "down" | null {
  if (keydownMatchesAction(event, "threads.move_up", false)) return "up";
  if (keydownMatchesAction(event, "threads.move_down", false)) return "down";
  return null;
}

/** The thread key of the sidebar row that holds focus, if any. */
export function focusedThreadRowKey(event: KeyboardEvent): string | undefined {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest(`.sidebar [${THREAD_ROW_KEY_ATTRIBUTE}]`);
  return row?.getAttribute(THREAD_ROW_KEY_ATTRIBUTE) ?? undefined;
}

/**
 * Whether this window can rename the thread: its backend supports it, and a
 * peer's thread pinned into the main window is reachable with turn control.
 * The sidebar row and the title strip both ask, so they agree.
 */
export function threadSupportsRename(
  thread: NavigationThreadSummary,
  backends: readonly BackendSummary[],
  inFederationWindow: boolean,
): boolean {
  const backendRenames = backends.some((backend) =>
    backend.kind === thread.source
    && backend.available
    && backend.capabilities.renameThread);
  if (!backendRenames) return false;
  if (!thread.federation || inFederationWindow) return true;
  return thread.federation.peerStatus === "connected"
    && thread.federation.capabilities?.includes("turn_control") === true;
}

/**
 * The one row being renamed. The Directories lens shows a thread once per
 * linked directory, so the thread alone could name several rows.
 */
export type RenamingThreadRow = { threadKey: string; directoryKey?: string };

export function isRenamingRow(
  renaming: RenamingThreadRow | undefined,
  threadKey: string,
  directoryKey: string | undefined,
): boolean {
  return renaming !== undefined
    && renaming.threadKey === threadKey
    && renaming.directoryKey === directoryKey;
}

/** The row a rename should edit: the one `origin` sits in, else the first. */
export function findThreadRowElement(
  root: ParentNode | null,
  threadKey: string,
  origin?: Element | null,
): Element | null {
  const own = origin?.closest(`[${THREAD_ROW_KEY_ATTRIBUTE}]`);
  if (own && own.getAttribute(THREAD_ROW_KEY_ATTRIBUTE) === threadKey) return own;
  if (root === null) return null;
  for (const row of root.querySelectorAll(`[${THREAD_ROW_KEY_ATTRIBUTE}]`)) {
    if (row.getAttribute(THREAD_ROW_KEY_ATTRIBUTE) === threadKey) return row;
  }
  return null;
}

export type ThreadHotkeyTargets = {
  keys: string[];
  /** "rows" when focus chose them in the sidebar, "open" for the open thread. */
  source: "rows" | "open";
};

export function resolveThreadHotkeyTargets(params: {
  focusedRowKey: string | undefined;
  selectedKeys: ReadonlySet<string>;
  openThreadKey: string | undefined;
}): ThreadHotkeyTargets | null {
  const { focusedRowKey, selectedKeys, openThreadKey } = params;
  if (focusedRowKey !== undefined) {
    return selectedKeys.size > 1 && selectedKeys.has(focusedRowKey)
      ? { keys: [...selectedKeys], source: "rows" }
      : { keys: [focusedRowKey], source: "rows" };
  }
  return openThreadKey === undefined ? null : { keys: [openThreadKey], source: "open" };
}

/**
 * The thread to open after the open thread is archived: the row after it in
 * the list as shown, or the one before when it was last. Rows that are
 * themselves being archived are skipped. `visibleKeys` is in display order.
 */
export function nextThreadAfterArchive(
  visibleKeys: readonly string[],
  archivedKeys: ReadonlySet<string>,
  openThreadKey: string,
): string | undefined {
  const index = visibleKeys.indexOf(openThreadKey);
  if (index < 0) return undefined;
  for (let next = index + 1; next < visibleKeys.length; next += 1) {
    if (!archivedKeys.has(visibleKeys[next]!)) return visibleKeys[next];
  }
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (!archivedKeys.has(visibleKeys[previous]!)) return visibleKeys[previous];
  }
  return undefined;
}

/** Thread keys of the rows the sidebar currently shows, top to bottom. */
export function readVisibleThreadRowKeys(root: ParentNode | null): string[] {
  if (root === null) return [];
  // The Directories lens shows a thread once per linked directory; the Set
  // keeps its first position.
  const keys = new Set<string>();
  for (const row of root.querySelectorAll(`[${THREAD_ROW_KEY_ATTRIBUTE}]`)) {
    const key = row.getAttribute(THREAD_ROW_KEY_ATTRIBUTE);
    if (key !== null) keys.add(key);
  }
  return [...keys];
}
