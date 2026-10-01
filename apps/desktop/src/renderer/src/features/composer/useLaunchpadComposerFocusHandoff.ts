import { useEffect, useLayoutEffect, type RefObject } from "react";
import type { ComposerInputHandle } from "./ComposerInputTypes";
import { subscribeLaunchpadComposerHandoffs } from "./launchpad-composer-handoff";
import type { ComposerDraftStore } from "./useComposerDraftStore";

type FocusHandoff = { element: Element; selectionIndex: number };
// Focus belongs to the current window and commit, never the durable draft.
const pendingFocus = new WeakMap<ComposerDraftStore, Map<string, FocusHandoff>>();

export function useLaunchpadComposerFocusHandoff(
  store: ComposerDraftStore,
  scopeKey: string,
  editorScopeKey: string,
  inputRef: RefObject<ComposerInputHandle | null>,
  inputWrapRef: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => subscribeLaunchpadComposerHandoffs(store, (source, target) => {
    const element = inputWrapRef.current?.querySelector("#thread-composer");
    if (source !== scopeKey || !element || document.activeElement !== element) return;
    let pending = pendingFocus.get(store);
    if (!pending) {
      pending = new Map();
      pendingFocus.set(store, pending);
    }
    const handoff = { element, selectionIndex: inputRef.current?.selectionStart ?? 0 };
    pending.set(target, handoff);
    // If navigation went elsewhere, visiting this thread later must not claim
    // the old focus. Allow the replacement editor's commit to consume it first.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (pending.get(target) === handoff) pending.delete(target);
    }));
  }), [store, scopeKey, inputRef, inputWrapRef]);

  useLayoutEffect(() => {
    // A reused Composer replaces its keyed editor in a second commit. Wait
    // for that editor, rather than returning focus to the one being removed.
    if (editorScopeKey !== scopeKey && !editorScopeKey.startsWith(`${scopeKey}#`)) return;
    const pending = pendingFocus.get(store);
    const handoff = pending?.get(scopeKey);
    if (!handoff) return;
    pending?.delete(scopeKey);
    const active = document.activeElement;
    if (active !== document.body && active !== handoff.element) return;
    const element = inputWrapRef.current?.querySelector<HTMLElement>("#thread-composer");
    if (!element || !inputRef.current) return;
    element.focus();
    // ProseMirror writes its selection to the DOM only while it owns focus.
    inputRef.current.setSelectionRange(handoff.selectionIndex, handoff.selectionIndex);
  }, [store, scopeKey, editorScopeKey, inputRef, inputWrapRef]);
}
