import { useEffect, useSyncExternalStore } from "react";

/**
 * X-ray: in the Compact and Minimal densities, holding the platform's command
 * key (⌘ on macOS, Ctrl elsewhere) lifts one thread row into a card showing
 * every chip, as Mission Control does, until the key is released. Which row
 * lifts, and how, is features/navigation/xray-spy-card.ts. A double press
 * pins X-ray on, and so does the pin in the X-ray badge; the same pin, or
 * another double press, turns it off. Modeled on IntelliJ's X-Ray mode.
 *
 * The state is one attribute, `<html data-xray>`, plus the lifted row's own
 * attributes. Rows therefore do not re-render on a peek.
 *
 * The key is held for shortcuts too, so a peek waits `XRAY_HOLD_MS` and is
 * called off by any other key or by a pointer press before it starts. A press
 * after the peek has started does not end it: the operator can ⌘-click the
 * badge's pin.
 */
export const XRAY_HOLD_MS = 350;
/** Longest gap between a tap's release and the next press for a double press. */
export const XRAY_DOUBLE_PRESS_MS = 400;

export type XrayState = {
  /** Rows show every chip: the key is held or X-ray is pinned. */
  active: boolean;
  pinned: boolean;
};

const INACTIVE: XrayState = { active: false, pinned: false };
let state: XrayState = INACTIVE;
const listeners = new Set<() => void>();

function setState(next: XrayState): void {
  if (next.active === state.active && next.pinned === state.pinned) return;
  state = next;
  if (typeof document !== "undefined") {
    document.documentElement.toggleAttribute("data-xray", next.active);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readXrayState(): XrayState {
  return state;
}

export function setXrayPinned(pinned: boolean): void {
  setState({ active: pinned, pinned });
}

export function useXrayState(): XrayState {
  return useSyncExternalStore(subscribe, readXrayState, () => INACTIVE);
}

/** The key X-ray listens for on this platform. */
export function xrayKey(platform: string | undefined): "Meta" | "Control" {
  return platform === "darwin" ? "Meta" : "Control";
}

export function xrayKeyLabel(platform: string | undefined): string {
  return platform === "darwin" ? "⌘" : "Ctrl";
}

/**
 * Installs the key handling while `enabled` (a density that hides chips).
 * Mount once per window that shows the thread list.
 */
export function useXrayMode(options: {
  enabled: boolean;
  platform: string | undefined;
}): void {
  const { enabled, platform } = options;
  useEffect(() => {
    if (!enabled) {
      setState(INACTIVE);
      return;
    }
    const key = xrayKey(platform);
    let holdTimer: number | null = null;
    let held = false;
    /** Another key or a press called this hold off; wait for the release. */
    let spoiled = false;
    /** The peek started during this hold. */
    let peeked = false;
    let lastTapReleasedAt = Number.NEGATIVE_INFINITY;

    const clearHold = (): void => {
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    const endPeek = (): void => {
      if (!state.pinned) setState(INACTIVE);
    };
    const spoil = (): void => {
      spoiled = true;
      clearHold();
      lastTapReleasedAt = Number.NEGATIVE_INFINITY;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== key) {
        if (held) {
          spoil();
          // A shortcut is under way: put the rows back.
          if (peeked) endPeek();
        }
        return;
      }
      if (event.repeat || held) return;
      held = true;
      spoiled = false;
      peeked = false;
      if (Date.now() - lastTapReleasedAt <= XRAY_DOUBLE_PRESS_MS) {
        lastTapReleasedAt = Number.NEGATIVE_INFINITY;
        spoiled = true;
        setXrayPinned(!state.pinned);
        return;
      }
      if (state.pinned) return;
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        if (!held || spoiled) return;
        peeked = true;
        setState({ active: true, pinned: false });
      }, XRAY_HOLD_MS);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key !== key || !held) return;
      held = false;
      clearHold();
      if (peeked) {
        peeked = false;
        endPeek();
        return;
      }
      lastTapReleasedAt = spoiled ? Number.NEGATIVE_INFINITY : Date.now();
    };

    const onPointerDown = (): void => {
      if (held && !peeked) spoil();
    };

    const onBlur = (): void => {
      held = false;
      peeked = false;
      clearHold();
      lastTapReleasedAt = Number.NEGATIVE_INFINITY;
      endPeek();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      clearHold();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
      setState(INACTIVE);
    };
  }, [enabled, platform]);
}
