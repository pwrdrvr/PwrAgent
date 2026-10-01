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
 *
 * A command the operator chose is the opposite of background churn: its
 * result must appear under the pointer that chose it. `reveal` releases the
 * freeze and keeps it released until that result has landed. Dropping the
 * freeze only before the command is not enough. The command's own DOM change
 * (a drop indicator clearing, a menu closing, pointer capture ending) fires a
 * `pointerover` under the stationary pointer, which would freeze the value
 * from before the command and hold it until the pointer leaves.
 */
export function useHoverStableSnapshot<T>(params: {
  hydrateFrozenValue?: (frozenValue: T, latestValue: T) => T;
  scope: string;
  /**
   * Ids of the reads the latest value is still waiting for. A command can
   * settle before the read it invalidated replaces the list, so a revealed
   * command keeps the freeze released until each read outstanding when it
   * settled has landed once. Reads invalidated later are background churn
   * and do not extend the wait.
   */
  outstandingReads?: readonly string[];
  value: T;
}): {
  onClickCapture: MouseEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
  onPointerLeave: PointerEventHandler<HTMLDivElement>;
  onPointerOut: PointerEventHandler<HTMLDivElement>;
  onPointerOver: PointerEventHandler<HTMLDivElement>;
  release: () => void;
  reveal: <Result>(operation: () => Result) => Result;
  value: T;
} {
  const latestValueRef = useRef(params.value);
  latestValueRef.current = params.value;
  const frozenValueRef = useRef(params.value);
  const hoveringRowRef = useRef(false);
  const scopeRef = useRef(params.scope);
  const pendingRevealsRef = useRef(0);
  // "settling": a revealed command just settled; the next render records
  // which reads it left outstanding. A set: those reads, until each lands.
  const awaitedReadsRef = useRef<"settling" | Set<string>>(undefined);
  const [, renderLatestValue] = useReducer((revision: number) => revision + 1, 0);

  if (awaitedReadsRef.current) {
    const outstanding = new Set(params.outstandingReads);
    const awaited = awaitedReadsRef.current === "settling"
      ? outstanding
      : new Set([...awaitedReadsRef.current].filter((id) => outstanding.has(id)));
    awaitedReadsRef.current = awaited.size > 0 ? awaited : undefined;
  }

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

  const reveal = useCallback(<Result>(operation: () => Result): Result => {
    release();
    const result = operation();
    if (!isPromiseLike(result)) {
      return result;
    }
    pendingRevealsRef.current += 1;
    const settle = (): void => {
      pendingRevealsRef.current -= 1;
      // The command invalidated its reads before it settled, so the render
      // this schedules sees them outstanding and keeps waiting for them.
      awaitedReadsRef.current = "settling";
      renderLatestValue();
    };
    result.then(settle, settle);
    return result;
  }, [release]);

  const onPointerOver = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      if (
        event.pointerType === "touch"
        || !closestHoverStableRow(event.target)
        || hoveringRowRef.current
        || pendingRevealsRef.current > 0
        || awaitedReadsRef.current
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

  // Leaving the rows ends a wait for a read that may never arrive, such as
  // one that failed and left its page stale. Re-entry freezes again.
  const onPointerLeave = useCallback<PointerEventHandler<HTMLDivElement>>(() => {
    awaitedReadsRef.current = undefined;
    release();
  }, [release]);

  return {
    onClickCapture,
    onPointerCancel: release,
    onPointerLeave,
    onPointerOut,
    onPointerOver,
    release,
    reveal,
    value: hoveringRowRef.current
      ? params.hydrateFrozenValue?.(frozenValueRef.current, params.value)
        ?? frozenValueRef.current
      : params.value,
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === "function";
}
