/**
 * The operator's keyboard shortcuts, as this window currently sees them.
 *
 * Main owns `~/.pwragent/keybindings.toml` and pushes every change, so this
 * store is a cache: it starts from the defaults, replaces them with the file's
 * overrides once the first read lands, and follows each push after that. A
 * keydown handler reads {@link getKeybindingsState} at the moment of the key,
 * so a rebind takes effect without re-subscribing any listener; components
 * that draw a chord use {@link useKeybindings}.
 */
import { useSyncExternalStore } from "react";
import {
  eventMatchesAction,
  formatAriaKeyShortcut,
  formatChordLabel,
  resolveKeybindings,
  type KeyEventLike,
  type KeybindingActionId,
  type KeybindingWriteRequest,
  type KeybindingsSnapshot,
  type ResolvedKeybindings,
} from "../../../shared/keybindings";
import { getDesktopApi } from "./desktop-api";

export type KeybindingsState = {
  /** `null` until the file has been read, and in a host without the bridge. */
  snapshot: KeybindingsSnapshot | null;
  bindings: ResolvedKeybindings;
  /** `process.platform` of the host; `undefined` matches either ⌘ or Ctrl. */
  platform: string | undefined;
};

const listeners = new Set<() => void>();
let state: KeybindingsState | undefined;
let started = false;

function buildState(snapshot: KeybindingsSnapshot | null): KeybindingsState {
  const platform = getDesktopApi()?.platform;
  return {
    snapshot,
    bindings: resolveKeybindings(snapshot?.overrides ?? {}, platform),
    platform,
  };
}

function apply(snapshot: KeybindingsSnapshot): void {
  state = buildState(snapshot);
  for (const listener of listeners) {
    listener();
  }
}

function ensureStarted(): void {
  if (started) return;
  const api = getDesktopApi();
  if (api === undefined) return;
  started = true;
  api.onKeybindingsChanged?.(apply);
  void api.readKeybindings?.().then(apply, () => {
    // The defaults stay in force; Settings shows the read failure on open.
  });
}

export function getKeybindingsState(): KeybindingsState {
  ensureStarted();
  // The platform is fixed in the app; a test stubs a different one per case.
  if (state === undefined || state.platform !== getDesktopApi()?.platform) {
    state = buildState(state?.snapshot ?? null);
  }
  return state;
}

function subscribe(listener: () => void): () => void {
  ensureStarted();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useKeybindings(): KeybindingsState {
  return useSyncExternalStore(subscribe, getKeybindingsState, getKeybindingsState);
}

/** The label of the action's first chord ("⇧⌘P"), or `undefined` if unbound. */
export function chordLabelFor(
  state: KeybindingsState,
  actionId: KeybindingActionId,
): string | undefined {
  const chord = state.bindings.get(actionId)?.[0];
  return chord === undefined ? undefined : formatChordLabel(chord, state.platform);
}

/** A tooltip with its shortcut: "Back  (⌘[)", or just "Back" when unbound. */
export function withChordHint(label: string, chord: string | undefined): string {
  return chord === undefined ? label : `${label}  (${chord})`;
}

/** Every chord of the action as an `aria-keyshortcuts` value. */
export function ariaKeyShortcutsFor(
  state: KeybindingsState,
  actionId: KeybindingActionId,
): string | undefined {
  const tokens = (state.bindings.get(actionId) ?? [])
    .map((chord) => formatAriaKeyShortcut(chord, state.platform))
    .filter((token): token is string => token !== null);
  return tokens.length === 0 ? undefined : tokens.join(" ");
}

/**
 * Whether a keydown presses the action's current chord where focus is.
 * `inTextField` is whether focus is in an editable control.
 */
export function keydownMatchesAction(
  event: KeyEventLike,
  actionId: KeybindingActionId,
  inTextField: boolean,
): boolean {
  const { bindings, platform } = getKeybindingsState();
  return eventMatchesAction(event, actionId, bindings, platform, inTextField);
}

/** Save one change to the file. Resolves with what the file now holds. */
export async function writeKeybindings(
  request: KeybindingWriteRequest,
): Promise<KeybindingsSnapshot> {
  const write = getDesktopApi()?.writeKeybindings;
  if (write === undefined) {
    throw new Error("Keyboard shortcuts cannot be saved in this window.");
  }
  const next = await write(request);
  apply(next);
  return next;
}

/** Tests only: forget the cache and the subscription to main. */
export function _resetKeybindingsStoreForTests(snapshot?: KeybindingsSnapshot): void {
  started = snapshot !== undefined;
  state = snapshot === undefined ? undefined : buildState(snapshot);
  for (const listener of listeners) {
    listener();
  }
}
