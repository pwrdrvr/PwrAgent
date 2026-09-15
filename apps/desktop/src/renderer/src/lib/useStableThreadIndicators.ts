import { useRef } from "react";

/** Navigation metadata refreshes must not invalidate every row's unchanged indicators. */
export function useStableThreadIndicators<T extends string | boolean>(
  indicators: Record<string, T>,
): Record<string, T> {
  const previous = useRef(indicators);
  if (previous.current !== indicators) {
    const keys = Object.keys(indicators);
    if (
      keys.length !== Object.keys(previous.current).length
      || keys.some((key) => previous.current[key] !== indicators[key])
    ) {
      previous.current = indicators;
    }
  }
  return previous.current;
}
