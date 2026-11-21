import { useId, useState } from "react";
import type {
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import { SettingsSectionStack } from "../SettingsLayout";
import { useGuidedSetupLauncher } from "./GuidedSetupLauncher";
import { messagingAcknowledgmentPatch } from "./messaging-acknowledgment";
import {
  GUIDED_MESSAGING_PROVIDERS,
  type GuidedMessagingProvider,
} from "./messaging-setup-flow";
import { MessagingSafetyNotice } from "./MessagingSafetyNotice";
import "./guided-setup.css";

/**
 * Stands in for every Settings → Messaging screen until an acknowledgement
 * is on record. The dense forms can enable adapters, store tokens, and
 * pair conversations, so none of them render before the operator has read
 * the three principles and the record exists.
 */
export function MessagingSafetyGate(props: {
  snapshot: DesktopSettingsSnapshot;
  saving: boolean;
  /** The platform screen the operator was heading to, if any. */
  focus?: GuidedMessagingProvider;
  writeConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
}) {
  const [ticked, setTicked] = useState(false);
  const [flashNonce, setFlashNonce] = useState(0);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string>();
  const hintId = useId();
  const launch = useGuidedSetupLauncher();
  const guidedProvider: GuidedMessagingProvider = props.focus ?? "telegram";
  const locked = !ticked || writing || props.saving;

  const acknowledge = async (
    settingUp: GuidedMessagingProvider | undefined,
    then?: () => void,
  ): Promise<void> => {
    if (writing) return;
    if (!ticked) {
      setFlashNonce((nonce) => nonce + 1);
      return;
    }
    setWriting(true);
    setError(undefined);
    try {
      // Record what is already switched on and what the operator is about
      // to set up, so the audit trail says which providers it covered.
      const enabled = GUIDED_MESSAGING_PROVIDERS.filter(
        (id) => props.snapshot.messaging[id].enabled.value,
      );
      const providers = settingUp && !enabled.includes(settingUp)
        ? [...enabled, settingUp]
        : enabled;
      const saved = await props.writeConfig(messagingAcknowledgmentPatch(providers));
      if (!saved) {
        setError("Could not save your acknowledgement. Try again.");
        return;
      }
      then?.();
    } finally {
      setWriting(false);
    }
  };

  return (
    <SettingsSectionStack paneId="messaging" aria-label="Messaging settings">
      <div className="settings-panel guided-setup-gate">
        <MessagingSafetyNotice
          acknowledged={ticked}
          onAcknowledgedChange={setTicked}
          flashNonce={flashNonce}
          hintId={hintId}
          headingLevel="h2"
        />
        <div className="guided-setup-gate__actions">
          {error ? (
            <span className="guided-setup__field-error" role="alert">
              {error}
            </span>
          ) : null}
          <button
            type="button"
            className={`guided-setup__btn guided-setup__btn--accent-outline${locked ? " is-soft-disabled" : ""}`}
            aria-disabled={locked || undefined}
            aria-describedby={!ticked ? hintId : undefined}
            onClick={() => void acknowledge(props.focus)}
          >
            {writing ? "Saving…" : "Continue to messaging settings"}
          </button>
          {launch ? (
            <button
              type="button"
              className={`guided-setup__btn guided-setup__btn--primary${locked ? " is-soft-disabled" : ""}`}
              aria-disabled={locked || undefined}
              aria-describedby={!ticked ? hintId : undefined}
              onClick={() =>
                void acknowledge(guidedProvider, () =>
                  launch({ flow: "messaging", provider: guidedProvider }),
                )
              }
            >
              Set up {providerLabel(guidedProvider)} step by step →
            </button>
          ) : null}
        </div>
      </div>
    </SettingsSectionStack>
  );
}

function providerLabel(id: GuidedMessagingProvider): string {
  switch (id) {
    case "telegram":
      return "Telegram";
    case "discord":
      return "Discord";
    case "mattermost":
      return "Mattermost";
    case "feishu":
      return "Feishu / Lark";
    case "slack":
      return "Slack";
    case "line":
      return "LINE";
  }
}
