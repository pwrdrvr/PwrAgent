import { useEffect, useLayoutEffect, useRef } from "react";
import type { NavigationBrowseMode } from "@pwragent/shared";
import type { KeybindingActionId } from "../../../../shared/keybindings";
import { isEditableTarget } from "../../lib/keyboard-accel";
import { keydownMatchesAction } from "../../lib/keybindings-store";

export const LENS_KEYBINDING_ACTIONS = {
  attention: "navigation.lens_attention",
  drafts: "navigation.lens_drafts",
  inbox: "navigation.lens_updated",
  recents: "navigation.lens_created",
  directories: "navigation.lens_directories",
} as const satisfies Record<NavigationBrowseMode, KeybindingActionId>;

/** One listener in App, so lens shortcuts also work with the sidebar hidden. */
export function useLensHotkeys(options: {
  browseMode: NavigationBrowseMode;
  onBrowseModeChange: (mode: NavigationBrowseMode) => void;
  threadLensesEmpty: boolean;
}): void {
  const current = useRef(options);
  const returnLens = useRef<NavigationBrowseMode | null>(null);
  useLayoutEffect(() => {
    current.current = options;
    // A click or another navigation action ends a temporary Attention visit.
    if (options.browseMode !== "attention") returnLens.current = null;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[aria-modal='true'], [role='menu'], [role='dialog'], [role='listbox']")) return;
      const inField = isEditableTarget(event);
      const toggle = keydownMatchesAction(event, "navigation.toggle_attention", inField);
      const { browseMode, onBrowseModeChange, threadLensesEmpty } = current.current;
      let nextMode: NavigationBrowseMode | undefined;
      if (toggle) {
        nextMode = browseMode === "attention" ? returnLens.current ?? undefined : "attention";
      } else {
        nextMode = (Object.keys(LENS_KEYBINDING_ACTIONS) as NavigationBrowseMode[])
          .find((mode) => keydownMatchesAction(event, LENS_KEYBINDING_ACTIONS[mode], inField));
      }
      if (nextMode === undefined && !toggle) return;
      event.preventDefault();
      if (event.repeat || nextMode === undefined || nextMode === browseMode
        || (threadLensesEmpty && nextMode !== "directories")) return;

      returnLens.current = toggle && nextMode === "attention" ? browseMode : null;
      current.current = { ...current.current, browseMode: nextMode };
      onBrowseModeChange(nextMode);
    };
    const captureComposerLensHotkey = (event: KeyboardEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (!isEditableTarget(event) || !target?.closest(".composer")) return;
      // ProseMirror also binds Mod+Alt+numbers to paragraph/headings. Give
      // lens shortcuts priority, as the sidebar does for thread shortcuts.
      onKeyDown(event);
      if (event.defaultPrevented) event.stopPropagation();
    };
    window.addEventListener("keydown", captureComposerLensHotkey, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", captureComposerLensHotkey, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
