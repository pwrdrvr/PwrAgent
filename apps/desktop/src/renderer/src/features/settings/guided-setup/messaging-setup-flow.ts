/**
 * Step graph for Settings' guided messaging setup.
 *
 *   safety → providers → provider-setup (one per picked provider) → done
 *
 * The flow can open on a provider ("Set up Telegram"), which skips the
 * picker. Whatever the entry, `safety` stands in for every step that can
 * connect a provider until an acknowledgement is on record: see
 * `visibleMessagingStep`. The reducer never reads the checkbox; it reads only
 * the stored acknowledgement the caller passes in.
 */

export type GuidedMessagingProvider =
  | "telegram"
  | "discord"
  | "mattermost"
  | "feishu"
  | "slack"
  | "line";

/** Setup order, lowest friction first. Telegram leads. */
export const GUIDED_MESSAGING_PROVIDERS: readonly GuidedMessagingProvider[] = [
  "telegram",
  "discord",
  "mattermost",
  "feishu",
  "slack",
  "line",
];

export type MessagingSetupStep =
  | "safety"
  | "providers"
  | "provider-setup"
  | "done";

export type MessagingSetupState = {
  step: MessagingSetupStep;
  /** Providers picked, in setup order. */
  selected: readonly GuidedMessagingProvider[];
  /** Index into `selected` while on `provider-setup`. */
  index: number;
  /** The provider the flow opened on, if any. It is picked from the start. */
  entryProvider?: GuidedMessagingProvider;
};

export type MessagingSetupEvent =
  | { type: "next" }
  | { type: "back" }
  | { type: "toggle-provider"; provider: GuidedMessagingProvider }
  | { type: "skip-provider" };

/** Steps that can write a provider's tokens, enable it, or pair it. */
export function stepConnectsProviders(step: MessagingSetupStep): boolean {
  return step === "providers" || step === "provider-setup";
}

/**
 * Where the flow opens. Without a record it opens on the safety screen.
 * With one it opens on the provider it was launched for, or the picker.
 */
export function initialMessagingSetupState(
  entryProvider: GuidedMessagingProvider | undefined,
  acknowledgedOnRecord: boolean,
): MessagingSetupState {
  const step: MessagingSetupStep = !acknowledgedOnRecord
    ? "safety"
    : entryProvider
      ? "provider-setup"
      : "providers";
  return {
    step,
    selected: entryProvider ? [entryProvider] : ["telegram"],
    index: 0,
    entryProvider,
  };
}

/**
 * The step to render. Without an acknowledgement on record every step that
 * connects providers shows the safety screen instead, however the state got
 * there: a stale state from before another window cleared the record, a
 * reducer bug, or a future entry point that starts mid-flow.
 */
export function visibleMessagingStep(
  state: MessagingSetupState,
  acknowledgedOnRecord: boolean,
): MessagingSetupStep {
  if (!acknowledgedOnRecord && stepConnectsProviders(state.step)) {
    return "safety";
  }
  return state.step;
}

export function reduceMessagingSetup(
  state: MessagingSetupState,
  event: MessagingSetupEvent,
  acknowledgedOnRecord: boolean,
): MessagingSetupState {
  const step = visibleMessagingStep(state, acknowledgedOnRecord);
  switch (event.type) {
    case "toggle-provider": {
      if (step !== "providers") return state;
      const picked = new Set(state.selected);
      if (picked.has(event.provider)) picked.delete(event.provider);
      else picked.add(event.provider);
      return {
        ...state,
        selected: GUIDED_MESSAGING_PROVIDERS.filter((id) => picked.has(id)),
      };
    }
    case "next": {
      if (step === "safety") {
        // The safety screen advances only once the record exists. The
        // caller writes it first, then sends `next` with the new snapshot.
        if (!acknowledgedOnRecord) return { ...state, step: "safety" };
        // Opened on a provider, the picker is skipped, but only while that
        // provider is still picked. Back to the picker, unpicking it, and
        // back again must not land on a provider step with nothing to set up.
        if (state.entryProvider && state.selected.includes(state.entryProvider)) {
          return { ...state, step: "provider-setup", index: 0 };
        }
        return { ...state, step: "providers", index: 0 };
      }
      if (step === "providers") {
        return state.selected.length > 0
          ? { ...state, step: "provider-setup", index: 0 }
          : { ...state, step: "done", index: 0 };
      }
      if (step === "provider-setup") {
        return state.index + 1 < state.selected.length
          ? { ...state, index: state.index + 1 }
          : { ...state, step: "done" };
      }
      return state;
    }
    case "skip-provider": {
      if (step !== "provider-setup") return state;
      return state.index + 1 < state.selected.length
        ? { ...state, index: state.index + 1 }
        : { ...state, step: "done" };
    }
    case "back": {
      if (step === "provider-setup") {
        if (state.index > 0) return { ...state, index: state.index - 1 };
        return { ...state, step: "providers", index: 0 };
      }
      if (step === "providers") return { ...state, step: "safety" };
      if (step === "done") {
        return state.selected.length > 0
          ? {
              ...state,
              step: "provider-setup",
              index: state.selected.length - 1,
            }
          : { ...state, step: "providers" };
      }
      return { ...state, step };
    }
  }
}

/** The provider being set up, if the visible step is a provider step. */
export function currentMessagingProvider(
  state: MessagingSetupState,
  acknowledgedOnRecord: boolean,
): GuidedMessagingProvider | undefined {
  if (visibleMessagingStep(state, acknowledgedOnRecord) !== "provider-setup") {
    return undefined;
  }
  return state.selected[state.index];
}
