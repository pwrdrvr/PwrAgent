import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

type Layer = {
  surfaceRef: RefObject<HTMLElement | null>;
  triggerRef?: RefObject<HTMLElement | null>;
  /** Read at dismiss time, so a re-rendered callback is never stale. */
  onDismiss: RefObject<() => void>;
};

/** Every layer currently open, in the order they opened. */
const openLayers: Layer[] = [];

function depth(el: HTMLElement): number {
  let n = 0;
  for (let node = el.parentElement; node !== null; node = node.parentElement) n++;
  return n;
}

/**
 * Which open layer owns this Escape.
 *
 * **The one holding focus wins**, the deepest when nested surfaces both hold
 * it, and open order only breaks ties. Cheaper rules each fail somewhere:
 *
 * - *Listener order.* The Markdown viewer, the sub-agent details dialog and
 *   the image lightbox each closed from their own capture listener on
 *   `window`. A lightbox or a second viewer opened from inside the Markdown
 *   viewer registered after it, so the viewer's listener ran first and one
 *   Escape closed both.
 * - *Open order alone.* React runs child effects before parent effects, so
 *   two layers mounting in one commit register innermost first.
 * - *The last layer that contains focus.* Nested layers both contain it.
 *   Depth is what tells them apart.
 *
 * Focus that sits in something unregistered claims nothing. Not every
 * floating surface uses this hook, and claiming the key there would close a
 * dialog while the operator was dismissing the thing on top of it. Only
 * "nowhere in particular" (`<body>`, nothing, a detached node) falls through
 * to the newest layer, which keeps Escape working after a click on a
 * dialog's text dropped focus to `<body>`.
 */
function escapeOwner(): Layer | undefined {
  const active = document.activeElement;
  if (active !== null) {
    let best: Layer | undefined;
    let bestDepth = -1;
    for (const layer of openLayers) {
      const surface = layer.surfaceRef.current;
      const trigger = layer.triggerRef?.current;
      // A popup's trigger belongs to it as much as the popup does: focus
      // often stays on the button that opened it.
      const holder =
        surface?.contains(active) === true
          ? surface
          : trigger?.contains(active) === true
            ? trigger
            : null;
      if (holder === null) continue;
      const d = depth(holder);
      // >= so a later-opened sibling at equal depth still wins.
      if (d >= bestDepth) {
        best = layer;
        bestDepth = d;
      }
    }
    if (best !== undefined) return best;
  }
  const nowhere =
    active === null || active === document.body || !active.isConnected;
  return nowhere ? openLayers[openLayers.length - 1] : undefined;
}

/**
 * One listener for every layer, so the owner is resolved once per keypress.
 *
 * Per-layer listeners cannot work: they all fire for the same key, and
 * dismissing the owner moves focus, so a listener running afterwards finds a
 * different owner and dismisses that too.
 *
 * Capture phase on `window`, so it runs before everything else in the
 * renderer. A claimed Escape is both prevented and stopped:
 *
 * - `preventDefault` is the signal the window listeners that already defer
 *   read. `ThreadFindBar` and the composer's autocomplete both close on an
 *   Escape nobody has claimed. The find bar used to close along with the
 *   branch-drift dialog in front of it.
 * - `stopPropagation` is for the handlers that do not check. The Star Map
 *   layer drops the operator's card selection on any Escape that reaches it
 *   through the React tree, and the dialogs it hosts portal out of its DOM
 *   but not out of that tree.
 *
 * An Escape pressed while an IME is composing belongs to the IME: it cancels
 * the composition, and must not also close the dialog holding the field.
 */
function onGlobalKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) {
    return;
  }
  const owner = escapeOwner();
  if (owner === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  restoreFocus(owner.triggerRef, owner.surfaceRef);
  owner.onDismiss.current();
}

function register(layer: Layer): void {
  if (openLayers.length === 0) {
    window.addEventListener("keydown", onGlobalKeyDown, true);
  }
  openLayers.push(layer);
}

function unregister(layer: Layer): void {
  const at = openLayers.indexOf(layer);
  if (at !== -1) openLayers.splice(at, 1);
  if (openLayers.length === 0) {
    window.removeEventListener("keydown", onGlobalKeyDown, true);
  }
}

/**
 * Escape-dismisses an open layer: a modal dialog (through `useModalDialog`),
 * or a popup that has to outrank the dialog it opens inside.
 *
 * A popup inside a dialog must use this, or the dialog owns its Escape and
 * one press closes both. `ProjectPicker` in the composer's Move to Project
 * dialog is the case that exists.
 *
 * A dismissal that refuses (a dialog mid-save) still claims the key. Escape
 * must not reach whatever is behind a dialog that stays open.
 */
export function useDismissableLayer({
  open,
  onDismiss,
  surfaceRef,
  triggerRef,
}: {
  open: boolean;
  onDismiss: () => void;
  /** The layer itself. Focus inside it makes it the owner. */
  surfaceRef: RefObject<HTMLElement | null>;
  /** The control that opened a popup. Focus returns here on Escape. */
  triggerRef?: RefObject<HTMLElement | null>;
}): void {
  // Held in a ref so a fresh closure never re-registers the layer, which
  // would move it to the top of the stack.
  const onDismissRef = useRef(onDismiss);
  useLayoutEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!open) return;
    const layer: Layer = {
      surfaceRef,
      onDismiss: onDismissRef,
      ...(triggerRef === undefined ? {} : { triggerRef }),
    };
    register(layer);
    return () => unregister(layer);
  }, [open, surfaceRef, triggerRef]);
}

/**
 * Hand focus back to a popup's trigger, but only if the popup owns it now.
 * An Escape that closes a dialog leaves this to `useFocusTrap`, which knows
 * the dialog's opener.
 */
function restoreFocus(
  triggerRef: RefObject<HTMLElement | null> | undefined,
  surfaceRef: RefObject<HTMLElement | null>,
): void {
  const trigger = triggerRef?.current;
  if (trigger === null || trigger === undefined) return;
  const active = document.activeElement;
  const inside =
    active === trigger
    || (active !== null && surfaceRef.current?.contains(active) === true);
  if (inside) trigger.focus();
}
