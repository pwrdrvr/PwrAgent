import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { HandoffInstanceThreadResult } from "@pwragent/shared";
import { THREAD_HANDOFF_CANCELLED_MESSAGE } from "../../../../shared/ipc";
import type { DesktopApi } from "../../lib/desktop-api";
import { cleanComposerErrorMessage } from "../composer/composer-error-message";
import { createThreadHandoffStore } from "./thread-handoff-store";
import type { ThreadHandoffChoice, ThreadHandoffTransferView } from "./thread-handoff-transfer";

type HandoffApi = Pick<
  DesktopApi,
  "handoffThreadToInstance" | "cancelThreadHandoff" | "retryThreadHandoffNow" | "onThreadHandoffProgress"
>;

export type StartThreadHandoff = {
  sourceThreadId: string;
  threadKey: string;
  title: string;
  targetLabel: string;
  choice: ThreadHandoffChoice;
};

/** Main ends a handoff that Cancel stopped with one fixed message. */
function isCancelled(message: string): boolean {
  return message === THREAD_HANDOFF_CANCELLED_MESSAGE;
}

/** The cause, without Electron's invoke wrapper or the peer's handler prefix. */
export function threadHandoffErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return cleanComposerErrorMessage(raw) || raw;
}

/**
 * The handoffs this window started. They live above the dialog, so closing
 * the dialog into the toast stack never stops one. The caller decides what a
 * settled handoff shows and removes it once it has.
 *
 * `transfers` holds only summaries, which do not change while bytes move, so
 * the caller re-renders on a step of the outcome, not on every byte report.
 * Components that draw progress read `store` for the one handoff they show.
 */
export function useThreadHandoffTransfers(api: HandoffApi | undefined) {
  const [store] = useState(createThreadHandoffStore);
  const transfers = useSyncExternalStore(store.subscribe, store.getSummaries);
  const dispatch = store.dispatch;

  const onProgress = api?.onThreadHandoffProgress;
  useEffect(() => {
    if (!onProgress) return;
    return onProgress((progress) => {
      dispatch({ type: "progress", at: performance.now(), progress });
    });
  }, [dispatch, onProgress]);

  const handoff = api?.handoffThreadToInstance;
  const start = useCallback(
    async (request: StartThreadHandoff): Promise<HandoffInstanceThreadResult | undefined> => {
      if (!handoff) throw new Error("Sending a thread is not available in this window.");
      const handoffId = crypto.randomUUID();
      dispatch({ type: "started", at: performance.now(), handoffId, ...request });
      try {
        const result = await handoff({
          sourceThreadId: request.sourceThreadId,
          targetInstanceId: request.choice.targetInstanceId,
          operation: request.choice.operation,
          handoffId,
          ...(request.choice.targetRepositoryPath
            ? { targetRepositoryPath: request.choice.targetRepositoryPath }
            : {}),
        });
        dispatch({ type: "succeeded", handoffId, result });
        return result;
      } catch (error) {
        const message = threadHandoffErrorMessage(error);
        dispatch(isCancelled(message)
          ? { type: "cancelled", handoffId }
          : { type: "failed", handoffId, error: message });
        return undefined;
      }
    },
    [dispatch, handoff],
  );

  const cancelApi = api?.cancelThreadHandoff;
  const cancel = useCallback((handoffId: string): void => {
    dispatch({ type: "cancel-requested", handoffId });
    void cancelApi?.({ handoffId });
  }, [cancelApi, dispatch]);

  const retryApi = api?.retryThreadHandoffNow;
  const retryNow = useCallback((handoffId: string): void => {
    void retryApi?.({ handoffId });
  }, [retryApi]);

  const show = useCallback((handoffId: string, view: ThreadHandoffTransferView): void => {
    dispatch({ type: "show", handoffId, view });
  }, [dispatch]);

  const remove = useCallback((handoffId: string): void => {
    dispatch({ type: "removed", handoffId });
  }, [dispatch]);

  return { store, transfers, start, cancel, retryNow, show, remove };
}
