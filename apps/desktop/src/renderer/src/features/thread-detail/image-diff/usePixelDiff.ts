import { useEffect, useRef, useState } from "react";
import type { DiffPlan } from "./image-diff-model";
import { computePixelDiff } from "./pixel-diff-client";

export type PixelDiffState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "ready"; url: string; changed: number; total: number }
  | { kind: "failed"; reason: string };

/**
 * The comparison as React state. Late replies are dropped: flipping "Scale to
 * match" mid-run starts a second comparison, and on a large pair the first
 * can still land afterwards and overwrite the answer that was asked for.
 */
export function usePixelDiff(params: {
  enabled: boolean;
  before: Blob | undefined;
  after: Blob | undefined;
  plan: DiffPlan | undefined;
}): PixelDiffState {
  const { enabled, before, after, plan } = params;
  const [state, setState] = useState<PixelDiffState>({ kind: "idle" });
  // The PNG's object URL outlives the render that made it, so the previous
  // one is released by hand or every toggle leaks a multi-megabyte image.
  const objectUrl = useRef<string | undefined>(undefined);
  const width = plan?.size.w ?? 0;
  const height = plan?.size.h ?? 0;
  const fit = plan?.fit;

  useEffect(() => () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  useEffect(() => {
    if (!enabled || !before || !after || !fit) {
      return;
    }
    let active = true;
    setState({ kind: "working" });
    computePixelDiff({ before, after, width, height, fit }).then(
      (result) => {
        if (!active) return;
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = URL.createObjectURL(result.png);
        setState({ kind: "ready", url: objectUrl.current, changed: result.changed, total: result.total });
      },
      (error: Error) => {
        if (active) setState({ kind: "failed", reason: error.message });
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, before, after, width, height, fit]);

  return state;
}
