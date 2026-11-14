import { useCallback, useRef, type ReactNode } from "react";
import type { ThreadTodo } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { useExecutionModeSelection } from "../../lib/useExecutionModeSelection";
import type { ThreadTodoRunOptions } from "./thread-todos-view";

/**
 * Whether running this card starts a thread at Full Access the operator has
 * not chosen yet. An agent proposed the mode, including one that could not
 * have started the thread itself (a Voice or Star Map manager at Default
 * Access), so the card is the operator's escalation and passes the gate.
 * Sending the prompt to an existing thread applies no mode, and a card that
 * names none inherits its own thread's, which raises nothing.
 */
export function threadTodoRunRaisesToFullAccess(
  todo: ThreadTodo,
  options?: ThreadTodoRunOptions,
): boolean {
  return todo.action?.type === "start_thread"
    && options?.messageTarget === undefined
    && todo.action.executionMode === "full-access";
}

export type ThreadTodoFullAccessGate = {
  /** Mount where the surface renders; it portals to `document.body`. */
  fullAccessRiskDialog: ReactNode;
  /**
   * Runs the card now, or once the operator accepts "Enable Full Access?".
   * A declined dialog leaves the promise pending, which the card reads as
   * "nothing happened". A second gated run replaces the first.
   */
  gateRun: <T>(
    todo: ThreadTodo,
    options: ThreadTodoRunOptions | undefined,
    run: () => Promise<T>,
  ) => Promise<T>;
};

export function useThreadTodoFullAccessGate(params: {
  desktopApi?: DesktopApi;
  dismissed?: boolean;
  onDismiss?: () => Promise<void>;
}): ThreadTodoFullAccessGate {
  const pendingRunRef = useRef<(() => void) | undefined>(undefined);
  const {
    fullAccessRiskDialog,
    requestExecutionModeSelection,
  } = useExecutionModeSelection({
    applyExecutionMode: () => {
      const run = pendingRunRef.current;
      pendingRunRef.current = undefined;
      run?.();
    },
    // The card's new thread does not exist yet, so nothing is at Full Access.
    currentExecutionMode: "default",
    ...params,
  });
  const gateRun = useCallback(<T,>(
    todo: ThreadTodo,
    options: ThreadTodoRunOptions | undefined,
    run: () => Promise<T>,
  ): Promise<T> => {
    if (!threadTodoRunRaisesToFullAccess(todo, options)) return run();
    return new Promise<T>((resolve, reject) => {
      pendingRunRef.current = () => {
        run().then(resolve, reject);
      };
      requestExecutionModeSelection("full-access");
    });
  }, [requestExecutionModeSelection]);
  return { fullAccessRiskDialog, gateRun };
}
