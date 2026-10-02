import { useCallback, useSyncExternalStore } from "react";
import { turnFailureAcknowledgements } from "./turn-failure-acknowledgements";

export function useTurnFailureDismissed(scope: string | undefined, message: string | undefined): boolean {
  // Stable subscription, scalar snapshot: unrelated failures do not repaint
  // this row, and a parent render cannot trigger a subscription/update loop.
  const subscribe = useCallback(
    (listener: () => void) => turnFailureAcknowledgements.subscribe(scope, listener),
    [scope],
  );
  const getSnapshot = useCallback(
    () => turnFailureAcknowledgements.isDismissed(scope, message),
    [scope, message],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function LinkedTurnFailureMessage(props: {
  scope?: string;
  message: string;
  className: string;
}) {
  const dismissed = useTurnFailureDismissed(props.scope, props.message);
  return dismissed ? null : <span className={props.className}>{props.message}</span>;
}
