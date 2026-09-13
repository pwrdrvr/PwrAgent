import { useLayoutEffect, useRef, type UIEvent } from "react";

/** Reading positions belong to each lens, independently of the selected thread. */
export function useLensScrollRestoration(key: string, ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const restored = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!ready || restored.current === key || !ref.current) return;
    ref.current.scrollTop = positions.current.get(key) ?? 0;
    restored.current = key;
  });
  useLayoutEffect(() => () => {
    restored.current = undefined;
  }, [key]);
  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (!ready || restored.current !== key) return;
    positions.current.delete(key);
    positions.current.set(key, event.currentTarget.scrollTop);
    if (positions.current.size > 25) positions.current.delete(positions.current.keys().next().value!);
  };
  return { ref, onScroll };
}
