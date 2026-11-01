import { useCallback, useEffect, useRef, useState } from "react";

export type PendingComposerInsert = { id: number; threadKey: string; text: string };

/**
 * One text insert waiting for a thread's composer, such as "Ask Agent to
 * Watch CI". The caller issues it in the same update that shows the thread.
 *
 * It waits only while the main view shows that thread. Once the view or the
 * selection settles anywhere else it is dropped, and a newer request replaces
 * it, so it can never land in the thread's draft later.
 *
 * `shownThreadKey` is the thread the main view shows, or undefined for any
 * other view.
 */
export function usePendingComposerInsert(shownThreadKey: string | undefined): {
  request: PendingComposerInsert | undefined;
  issue: (threadKey: string, text: string) => void;
  handled: (id: number) => void;
} {
  const [request, setRequest] = useState<PendingComposerInsert>();
  const nextIdRef = useRef(0);
  const handled = useCallback((id: number) => {
    setRequest((current) => current?.id === id ? undefined : current);
  }, []);
  const issue = useCallback((threadKey: string, text: string) => {
    nextIdRef.current += 1;
    setRequest({ id: nextIdRef.current, threadKey, text });
  }, []);
  useEffect(() => {
    if (request && request.threadKey !== shownThreadKey) handled(request.id);
  }, [request, shownThreadKey, handled]);
  return { request, issue, handled };
}
