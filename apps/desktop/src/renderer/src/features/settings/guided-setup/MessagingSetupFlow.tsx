import { useCallback, useId, useState } from "react";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { DesktopSettingsState } from "../useDesktopSettings";
import {
  GuidedFooterBack,
  GuidedFooterHint,
  GuidedFooterSpacer,
  GuidedSetupFrame,
} from "./GuidedSetupFrame";
import {
  isMessagingAcknowledged,
  messagingAcknowledgmentPatch,
  messagingAcknowledgmentWithProviders,
} from "./messaging-acknowledgment";
import {
  currentMessagingProvider,
  initialMessagingSetupState,
  reduceMessagingSetup,
  visibleMessagingStep,
  type GuidedMessagingProvider,
  type MessagingSetupEvent,
} from "./messaging-setup-flow";
import { MessagingSafetyNotice } from "./MessagingSafetyNotice";
import {
  MessagingProvidersStep,
  ProviderSetupStep,
  providerName,
} from "./MessagingSetupSteps";
import { ReviewSummary } from "./ReviewSummary";

/**
 * Guided messaging setup: the safety screen, a provider picker, one
 * provider at a time, and a summary. Opened on a provider ("Set up
 * Telegram") it skips the picker. The safety screen always comes first
 * until an acknowledgement is on record, and stands in for any provider
 * step if the record goes away mid-flow.
 */
export function MessagingSetupFlow(props: {
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  entryProvider?: GuidedMessagingProvider;
  onClose: () => void;
}) {
  const snapshot = props.settings.snapshot;
  const acknowledgedOnRecord = isMessagingAcknowledged(snapshot);
  const [state, setState] = useState(() =>
    initialMessagingSetupState(props.entryProvider, acknowledgedOnRecord),
  );
  // The checkbox. Ticking it lifts nothing by itself: Continue writes the
  // record, and the record lifts the gate.
  const [ticked, setTicked] = useState(acknowledgedOnRecord);
  const [flashNonce, setFlashNonce] = useState(0);
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string>();
  const hintId = useId();

  const step = visibleMessagingStep(state, acknowledgedOnRecord);
  const provider = currentMessagingProvider(state, acknowledgedOnRecord);

  const dispatch = useCallback(
    (event: MessagingSetupEvent, acknowledged = acknowledgedOnRecord): void => {
      setState((current) => reduceMessagingSetup(current, event, acknowledged));
    },
    [acknowledgedOnRecord],
  );

  const continueFromSafety = async (): Promise<void> => {
    if (writing) return;
    if (!ticked) {
      setFlashNonce((nonce) => nonce + 1);
      return;
    }
    if (acknowledgedOnRecord) {
      dispatch({ type: "next" });
      return;
    }
    setWriting(true);
    setWriteError(undefined);
    try {
      const saved = await props.settings.writeConfig(
        messagingAcknowledgmentPatch(
          props.entryProvider ? [props.entryProvider] : [],
        ),
      );
      if (!saved) {
        setWriteError("Could not save your acknowledgement. Try again.");
        return;
      }
      // writeConfig adopted the new snapshot; the record is there now.
      dispatch({ type: "next" }, true);
    } finally {
      setWriting(false);
    }
  };

  const finish = async (): Promise<void> => {
    // Add what was set up to the record, keeping when it was acknowledged.
    const patch = messagingAcknowledgmentWithProviders(
      snapshot?.general.messagingAcknowledgment.value,
      state.selected,
    );
    if (patch) await props.settings.writeConfig(patch);
    props.onClose();
  };

  const railIndex =
    step === "safety" ? 0 : step === "providers" ? 1 : step === "provider-setup" ? 2 : 3;
  const steps = [
    { label: acknowledgedOnRecord ? "Acknowledged" : "Before you connect" },
    {
      label: state.entryProvider
        ? providerName(state.entryProvider)
        : step === "safety" || step === "providers"
          ? "Pick providers"
          : `${state.selected.length} picked`,
    },
    {
      label: provider
        ? `${providerName(provider)} (${state.index + 1} of ${state.selected.length})`
        : "Connect",
    },
    { label: "Review" },
  ];

  const crumb = provider
    ? `Messaging — ${providerName(provider)}`
    : step === "safety"
      ? "Messaging — Before you connect"
      : step === "providers"
        ? "Messaging — Pick providers"
        : "Messaging — Review";

  let footer;
  if (step === "safety") {
    const locked = !ticked || writing;
    // As in first-run setup: skipping is the default (filled) action and
    // Continue is the deliberate one. Continue stays clickable while the box
    // is unticked so a click can point at the box instead of doing nothing.
    footer = (
      <>
        <GuidedFooterSpacer />
        {writeError ? <GuidedFooterHint>{writeError}</GuidedFooterHint> : null}
        <button
          type="button"
          className={`guided-setup__btn guided-setup__btn--accent-outline${locked ? " is-soft-disabled" : ""}`}
          aria-disabled={locked || undefined}
          aria-describedby={!ticked ? hintId : undefined}
          onClick={() => void continueFromSafety()}
        >
          {writing ? "Saving…" : "Continue with messaging →"}
        </button>
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--primary"
          disabled={writing}
          onClick={props.onClose}
        >
          Skip messaging for now
        </button>
      </>
    );
  } else if (step === "providers") {
    footer = (
      <>
        <GuidedFooterBack onBack={() => dispatch({ type: "back" })} />
        <GuidedFooterSpacer />
        <GuidedFooterHint>
          {state.selected.length > 0
            ? `${state.selected.length} provider${state.selected.length === 1 ? "" : "s"} selected`
            : "No providers selected"}
        </GuidedFooterHint>
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--primary"
          onClick={() => dispatch({ type: "next" })}
        >
          {state.selected.length > 0 ? "Set up →" : "Finish →"}
        </button>
      </>
    );
  } else if (step === "provider-setup") {
    const isLast = state.index + 1 >= state.selected.length;
    footer = (
      <>
        <GuidedFooterBack onBack={() => dispatch({ type: "back" })} />
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--link"
          onClick={() => dispatch({ type: "skip-provider" })}
        >
          Skip {provider ? providerName(provider) : "this provider"}
        </button>
        <GuidedFooterSpacer />
        <GuidedFooterHint>
          Provider {state.index + 1} of {state.selected.length}
        </GuidedFooterHint>
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--primary"
          onClick={() => dispatch({ type: "next" })}
        >
          {isLast ? "Review →" : "Next provider →"}
        </button>
      </>
    );
  } else {
    footer = (
      <>
        <GuidedFooterBack onBack={() => dispatch({ type: "back" })} />
        <GuidedFooterSpacer />
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--primary"
          disabled={props.settings.saving}
          onClick={() => void finish()}
        >
          Done
        </button>
      </>
    );
  }

  return (
    <GuidedSetupFrame
      title="Set up messaging"
      crumb={crumb}
      steps={steps}
      currentIndex={railIndex}
      busy={writing}
      onClose={props.onClose}
      footer={footer}
      stepKey={`${step}:${provider ?? ""}`}
    >
      {step === "safety" ? (
        <MessagingSafetyNotice
          acknowledged={ticked}
          onAcknowledgedChange={setTicked}
          flashNonce={flashNonce}
          hintId={hintId}
          recordedAt={snapshot?.general.messagingAcknowledgment.value?.acknowledgedAt}
        />
      ) : null}
      {step === "providers" ? (
        <MessagingProvidersStep
          selected={state.selected}
          onToggle={(id) => dispatch({ type: "toggle-provider", provider: id })}
        />
      ) : null}
      {step === "provider-setup" && provider ? (
        <ProviderSetupStep
          key={provider}
          provider={provider}
          settings={props.settings}
          desktopApi={props.desktopApi}
        />
      ) : null}
      {step === "done" ? (
        <ReviewSummary
          title={state.selected.length > 0 ? "Messaging is set up" : "No providers picked"}
          sub="Add authorized users, groups, or channels later from Settings → Messaging."
          rows={state.selected.map((id) => ({
            key: id,
            label: providerName(id),
            value: messagingProviderSummary(id, props.settings),
          }))}
        />
      ) : null}
    </GuidedSetupFrame>
  );
}

function messagingProviderSummary(
  id: GuidedMessagingProvider,
  settings: DesktopSettingsState,
): string {
  const platform = settings.snapshot?.messaging[id];
  if (!platform) return "Not set up";
  return platform.enabled.value ? "Adapter on" : "Adapter off";
}
