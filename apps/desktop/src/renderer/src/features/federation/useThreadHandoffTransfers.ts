import { useCallback, useEffect, useReducer } from "react";
import type { HandoffInstanceThreadResult } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  reduceThreadHandoffTransfers,
  type ThreadHandoffChoice,
  type ThreadHandoffTransferView,
  type ThreadHandoffTransfers,
} from "./thread-handoff-transfer";

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

/** An abort from Cancel reaches the renderer as a rejected invoke. */
function isAbort(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /AbortError|operation was aborted/i.test(text);
}

/** Electron prefixes a rejected invoke with the channel; the operator needs the cause. */
export function threadHandoffErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

/**
 * The handoffs this window started. They live above the dialog, so closing
 * the dialog into the toast stack never stops one. The caller decides what a
 * settled handoff shows and removes it once it has.
 */
export function useThreadHandoffTransfers(api: HandoffApi | undefined) {
  const [transfers, dispatch] = useReducer(reduceThreadHandoffTransfers, {} as ThreadHandoffTransfers);

  const onProgress = api?.onThreadHandoffProgress;
  useEffect(() => {
    if (!onProgress) return;
    return onProgress((progress) => {
      dispatch({ type: "progress", at: performance.now(), progress });
    });
  }, [onProgress]);

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
        dispatch(isAbort(error)
          ? { type: "cancelled", handoffId }
          : { type: "failed", handoffId, error: threadHandoffErrorMessage(error) });
        return undefined;
      }
    },
    [handoff],
  );

  const cancelApi = api?.cancelThreadHandoff;
  const cancel = useCallback((handoffId: string): void => {
    dispatch({ type: "cancel-requested", handoffId });
    void cancelApi?.({ handoffId });
  }, [cancelApi]);

  const retryApi = api?.retryThreadHandoffNow;
  const retryNow = useCallback((handoffId: string): void => {
    void retryApi?.({ handoffId });
  }, [retryApi]);

  const show = useCallback((handoffId: string, view: ThreadHandoffTransferView): void => {
    dispatch({ type: "show", handoffId, view });
  }, []);

  const remove = useCallback((handoffId: string): void => {
    dispatch({ type: "removed", handoffId });
  }, []);

  return { transfers, start, cancel, retryNow, show, remove };
}
