import { useCallback, useRef } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import type { ThreadContextWindowState } from "../../lib/useThreadSessionState";
import type { ThreadInfoContext } from "./thread-info";

export type OpenThreadContext = ThreadInfoContext & { threadKey: string };

/**
 * The open thread's context reading, read by its sidebar card when the card
 * opens. A stable getter over a ref, so a reading per turn re-renders
 * nothing that holds it.
 */
export function useOpenThreadContextReader(
  thread: NavigationThreadSummary | undefined,
  contextWindow: ThreadContextWindowState | undefined,
): () => OpenThreadContext | undefined {
  const ref = useRef<OpenThreadContext | undefined>(undefined);
  ref.current = thread && contextWindow
    ? {
        threadKey: threadSummaryIdentityKey(thread),
        totalTokens: contextWindow.totalTokens,
        modelContextWindow: contextWindow.modelContextWindow,
      }
    : undefined;
  return useCallback(() => ref.current, []);
}
