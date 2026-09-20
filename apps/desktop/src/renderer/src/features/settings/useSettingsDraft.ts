import { useState } from "react";

type DraftValue = string | number | boolean;

export type SettingsDraft<T extends Record<string, DraftValue>> = {
  /** What each field shows: the operator's edit, else the saved value. */
  values: T;
  /** True while any field holds an edit that differs from what is saved. */
  dirty: boolean;
  set: <K extends keyof T>(key: K, value: T[K]) => void;
  /** Drops edits so those fields show the saved value again. No keys: all. */
  discard: (...keys: Array<keyof T>) => void;
};

/**
 * The local state of an explicit-save settings form.
 *
 * Each field shows its saved value until the operator edits it, and then keeps
 * the edit until it is saved or discarded. The saved values arrive in the
 * settings snapshot, which changes on any config write from any section or
 * window. Copying the whole snapshot back into the form on every change threw
 * away unsaved edits; here a new snapshot only moves fields nobody has touched.
 */
export function useSettingsDraft<T extends Record<string, DraftValue>>(
  saved: T,
): SettingsDraft<T> {
  const [state, setState] = useState<{ saved: T; edits: Partial<T> }>(() => ({
    saved,
    edits: {},
  }));
  let edits = state.edits;
  if (!sameValues(state.saved, saved)) {
    // An edit that now matches what is saved is no longer an edit: its save
    // landed, or another window saved the same value. Dropping it here keeps
    // the field following the saved value from now on.
    edits = withoutSaved(edits, saved);
    setState({ saved, edits });
  }
  const values = { ...saved, ...edits };
  return {
    values,
    dirty: Object.keys(edits).length > 0,
    set: (key, value) =>
      setState((current) => {
        const next = { ...current.edits };
        if (Object.is(value, current.saved[key])) {
          delete next[key];
        } else {
          next[key] = value;
        }
        return { ...current, edits: next };
      }),
    discard: (...keys) =>
      setState((current) => {
        if (keys.length === 0) return { ...current, edits: {} };
        const next = { ...current.edits };
        for (const key of keys) delete next[key];
        return { ...current, edits: next };
      }),
  };
}

function sameValues<T extends Record<string, DraftValue>>(a: T, b: T): boolean {
  return Object.keys(b).every((key) => Object.is(a[key], b[key]));
}

function withoutSaved<T extends Record<string, DraftValue>>(
  edits: Partial<T>,
  saved: T,
): Partial<T> {
  const next: Partial<T> = {};
  for (const key of Object.keys(edits) as Array<keyof T>) {
    if (!Object.is(edits[key], saved[key])) next[key] = edits[key];
  }
  return next;
}
