import { useEffect, useState } from "react";

/**
 * What to print on a key cap, given where the key sits on the board.
 *
 * The camera binds by physical position (`KeyboardEvent.code`), which is
 * what makes WASD work on every layout. That leaves the hint with a problem
 * it cannot solve from the binding alone: on AZERTY the key in the W
 * position is engraved Z, so drawing a "W" cap points a French operator at
 * the wrong key even though pressing the right one works.
 *
 * `navigator.keyboard.getLayoutMap()` answers exactly this — code to the
 * character that key currently produces — so the hint can be labelled for
 * the board in front of the operator. Chromium-only, which is fine for
 * Electron, and it degrades to the QWERTY engravings anywhere it is absent.
 *
 * Deliberately labels only; nothing here influences what the keys DO.
 */

/** The subset of the Keyboard Map API this needs. */
type KeyboardLayoutSource = {
  keyboard?: {
    getLayoutMap?: () => Promise<Map<string, string>>;
  };
};

export type StarMapKeyCapLabels = Readonly<Record<string, string>>;

/** QWERTY engravings — the fallback, and the shape of the result. */
export const DEFAULT_KEY_CAP_LABELS: StarMapKeyCapLabels = {
  KeyW: "W",
  KeyA: "A",
  KeyS: "S",
  KeyD: "D",
};

/**
 * Resolve cap labels for the codes we draw, falling back per-code.
 *
 * Exported for tests: the layout map is a browser capability, so the
 * merging rules are worth pinning without one.
 */
export function resolveKeyCapLabels(
  layout: ReadonlyMap<string, string> | undefined,
): StarMapKeyCapLabels {
  if (!layout) return DEFAULT_KEY_CAP_LABELS;
  const resolved: Record<string, string> = { ...DEFAULT_KEY_CAP_LABELS };
  for (const code of Object.keys(DEFAULT_KEY_CAP_LABELS)) {
    const engraved = layout.get(code);
    // A dead key or a non-printing position reports "" or a multi-character
    // name; neither fits a 18px cap, so keep the QWERTY letter rather than
    // draw something unreadable.
    if (engraved && engraved.length === 1) {
      resolved[code] = engraved.toUpperCase();
    }
  }
  return resolved;
}

/**
 * Cap labels for the operator's actual keyboard layout.
 *
 * Starts on the QWERTY fallback and swaps in the real engravings once the
 * async layout map resolves — a frame of "W A S D" on an AZERTY board beats
 * a frame of nothing, and the binding is correct either way.
 */
export function useKeyboardLayoutLabels(): StarMapKeyCapLabels {
  const [labels, setLabels] = useState<StarMapKeyCapLabels>(
    DEFAULT_KEY_CAP_LABELS,
  );

  useEffect(() => {
    const source = navigator as Navigator & KeyboardLayoutSource;
    const getLayoutMap = source.keyboard?.getLayoutMap;
    if (!getLayoutMap) return;
    let cancelled = false;
    // Rejects when the document is not focused, among other things; a hint
    // labelled QWERTY is a cosmetic miss, not a reason to surface an error.
    Promise.resolve(getLayoutMap.call(source.keyboard))
      .then((layout) => {
        if (!cancelled) setLabels(resolveKeyCapLabels(layout));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return labels;
}
