import { useEffect, useRef, useState } from "react";

export function useComposerSendPreparation(composerScopeKey: string) {
  const [sending, setSendingState] = useState(false);
  const sendingRef = useRef(false);
  const updateSending = (nextSending: boolean): void => {
    sendingRef.current = nextSending;
    setSendingState(nextSending);
  };
  const [preparingSend, setPreparingSend] = useState(false);
  const sendPreparationRef = useRef<AbortController | undefined>(undefined);
  // One teardown for every way a preparation ends early. The preparation is
  // what set `sending` true, and the abort makes `prepareThreadTurnPayload`
  // return before its own reset, so releasing it belongs here rather than at
  // each call site. On a scope change the controller's draft-rehydration
  // effect also clears `sending`; saying it here too keeps this function
  // correct on its own instead of load-bearing on that ordering.
  const abandonSendPreparation = (): void => {
    const preparation = sendPreparationRef.current;
    sendPreparationRef.current = undefined;
    if (!preparation) {
      return;
    }
    preparation.abort();
    setPreparingSend(false);
    updateSending(false);
  };
  const cancelSendPreparation = abandonSendPreparation;
  useEffect(() => {
    setPreparingSend(false);
    return abandonSendPreparation;
  }, [composerScopeKey]);

  return {
    sending,
    sendingRef,
    updateSending,
    preparingSend,
    setPreparingSend,
    sendPreparationRef,
    cancelSendPreparation,
  };
}
