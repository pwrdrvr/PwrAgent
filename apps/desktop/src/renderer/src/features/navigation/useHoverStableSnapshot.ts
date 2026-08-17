import { useCallback, useReducer, useRef } from "react";
import type { PointerEventHandler } from "react";

const HOVER_STABLE_ROW_SELECTOR = "[data-hover-stable-row]";

function closestHoverStableRow(target: EventTarget | null): Element | null {
  return target instanceof Element
    ? target.closest(HOVER_STABLE_ROW_SELECTOR)
    : null;
}

/**
 * Hold one rendered navigation snapshot while the pointer rests on its rows.
 *
 * Every lens keeps computing its authoritative order in the parent. This hook
 * only delays when that newest snapshot becomes visible, so an update cannot
 * replace the card under a stationary pointer between pointer-down and click.
 * Leaving the row area reveals the latest snapshot in one render.
 */
export function useHoverStableSnapshot<T>(params: {
  scope: string;
  value: T;
}): {
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

  return {
    onPointerCancel: release,
    onPointerLeave: release,
    onPointerOut,
    onPointerOver,
    value: hoveringRowRef.current ? frozenValueRef.current : params.value,
  };
}
