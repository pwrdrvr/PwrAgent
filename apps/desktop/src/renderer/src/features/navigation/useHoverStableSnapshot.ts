import { useCallback, useReducer, useRef } from "react";
import type { MouseEventHandler, PointerEventHandler } from "react";

const HOVER_STABLE_ROW_SELECTOR = "[data-hover-stable-row]";
const HOVER_STABLE_RELEASE_SELECTOR = "[data-hover-stable-release]";

function closestHoverStableRow(target: EventTarget | null): Element | null {
  return target instanceof Element
    ? target.closest(HOVER_STABLE_ROW_SELECTOR)
    : null;
}

function closestHoverStableRelease(target: EventTarget | null): Element | null {
  return target instanceof Element
    ? target.closest(HOVER_STABLE_RELEASE_SELECTOR)
    : null;
}

/**
 * Hold one rendered navigation snapshot while the pointer rests on its rows.
 *
 * Every lens keeps computing its authoritative order in the parent. This hook
 * only delays when that newest snapshot becomes visible, so an update cannot
 * replace the card under a stationary pointer between pointer-down and click.
 * A caller can hydrate non-positional fields from the latest value while the
 * structure is frozen. Leaving the row area reveals the latest snapshot in
 * one render.
 */
export function useHoverStableSnapshot<T>(params: {
  hydrateFrozenValue?: (frozenValue: T, latestValue: T) => T;
  scope: string;
  value: T;
}): {
  onClickCapture: MouseEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
  onPointerLeave: PointerEventHandler<HTMLDivElement>;
  onPointerOut: PointerEventHandler<HTMLDivElement>;
  onPointerOver: PointerEventHandler<HTMLDivElement>;
  value: T;
} {
  const latestValueRef = useRef(params.value);
  latestValueRef.current = params.value;
  const frozenValueRef = useRef(params.value);
  const hoveringRowRef = useRef(false);
  const scopeRef = useRef(params.scope);
  const [, renderLatestValue] = useReducer((revision: number) => revision + 1, 0);

  if (scopeRef.current !== params.scope) {
    scopeRef.current = params.scope;
    hoveringRowRef.current = false;
    frozenValueRef.current = params.value;
  }

  const release = useCallback(() => {
    if (!hoveringRowRef.current) return;
    hoveringRowRef.current = false;
    renderLatestValue();
  }, []);

  const onPointerOver = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      if (
        event.pointerType === "touch"
        || !closestHoverStableRow(event.target)
        || hoveringRowRef.current
      ) {
        return;
      }
      frozenValueRef.current = latestValueRef.current;
      hoveringRowRef.current = true;
    },
    [],
  );

  const onPointerOut = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      if (!hoveringRowRef.current || !closestHoverStableRow(event.target)) {
        return;
      }
      const nextRow = closestHoverStableRow(event.relatedTarget);
      if (nextRow && event.currentTarget.contains(nextRow)) {
        return;
      }
      release();
    },
    [release],
  );

  const onClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (closestHoverStableRelease(event.target)) {
        release();
      }
    },
    [release],
  );

  return {
    onClickCapture,
    onPointerCancel: release,
    onPointerLeave: release,
    onPointerOut,
    onPointerOver,
    value: hoveringRowRef.current
      ? params.hydrateFrozenValue?.(frozenValueRef.current, params.value)
        ?? frozenValueRef.current
      : params.value,
  };
}
