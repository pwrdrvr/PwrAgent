import type {
  DesktopSettingsSnapshot,
  DesktopToolOutputAlertPolicy,
} from "@pwragent/shared";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";
import { sourceBadge } from "./settings-fields";

const DEFAULT_THREAD_PRICING_SUMMARY = {
  value: true,
  source: "default" as const,
};

const DEFAULT_THREAD_PRICING_DISPLAY_USD = {
  value: true,
  source: "default" as const,
};

const DEFAULT_THREAD_PRICING_DISPLAY_CODEX_CREDITS = {
  value: false,
  source: "default" as const,
};

export function PricingSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onThreadPricingSummaryChange: (enabled: boolean) => Promise<void>;
  onThreadPricingDisplayUsdChange: (enabled: boolean) => Promise<void>;
  onThreadPricingDisplayCodexCreditsChange: (enabled: boolean) => Promise<void>;
  onToolOutputAlertsChange: (
    patch: Partial<DesktopToolOutputAlertPolicy>,
  ) => Promise<void>;
}) {
  const threadPricingSummary =
    props.snapshot.experimental.threadPricingSummary ??
    DEFAULT_THREAD_PRICING_SUMMARY;
  const threadPricingDisplayUsd =
    props.snapshot.experimental.threadPricingDisplayUsd ??
    DEFAULT_THREAD_PRICING_DISPLAY_USD;
  const threadPricingDisplayCodexCredits =
    props.snapshot.experimental.threadPricingDisplayCodexCredits ??
    DEFAULT_THREAD_PRICING_DISPLAY_CODEX_CREDITS;
  const toolOutputAlerts = props.snapshot.general.toolOutputAlerts;
  const displayControlsDisabled = props.saving || !threadPricingSummary.value;

  return (
    <SettingsSectionStack paneId="pricing" aria-label="Usage and pricing settings">
      <SettingsPanelHead
        eyebrow="Pricing"
        title="Usage & pricing"
        help="Control how thread usage costs are shown and which usage patterns raise alerts."
      />

      <SettingsSection
        eyebrow="Pricing"
        title="Thread pricing"
        description="Show estimated usage totals and per-turn details in the thread context rail."
        chip={threadPricingSummary.value ? "On" : "Off"}
        chipKind={threadPricingSummary.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Show thread pricing"
            sub="Show the Pricing tab in the thread context rail."
            help="Pricing is estimated from published provider rates and may differ from billed usage."
            source={sourceBadge(threadPricingSummary)}
            control={
              <SettingsSwitch
                checked={threadPricingSummary.value}
                disabled={props.saving}
                label="Show thread pricing"
                onChange={(enabled) => {
                  void props.onThreadPricingSummaryChange(enabled);
                }}
              />
            }
          />
          <SettingsField
            label="Price displays"
            sub="Choose one or both estimates to show with thread usage."
            help="List Price uses each provider's published rates. Codex Credits use Codex's token-based credit rate card."
            control={
              <div
                className="settings-segmented"
                role="group"
                aria-label="Price displays"
              >
                <button
                  aria-pressed={threadPricingDisplayUsd.value}
                  className={`settings-segmented__button${
                    threadPricingDisplayUsd.value ? " is-active" : ""
                  }`}
                  disabled={displayControlsDisabled}
                  type="button"
                  onClick={() => {
                    void props.onThreadPricingDisplayUsdChange(
                      !threadPricingDisplayUsd.value,
                    );
                  }}
                >
                  List Price
                </button>
                <button
                  aria-pressed={threadPricingDisplayCodexCredits.value}
                  className={`settings-segmented__button${
                    threadPricingDisplayCodexCredits.value ? " is-active" : ""
                  }`}
                  disabled={displayControlsDisabled}
                  type="button"
                  onClick={() => {
                    void props.onThreadPricingDisplayCodexCreditsChange(
                      !threadPricingDisplayCodexCredits.value,
                    );
                  }}
                >
                  Codex Credits
                </button>
              </div>
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Usage"
        title="Alerts"
        description="Choose which costly or lossy tool-use patterns should interrupt you."
        chip={sourceBadge(toolOutputAlerts.repeatedLargeOutputsEnabled)}
      >
        <div className="settings-fields">
          <SettingsField
            label="Tool output reaches the cap"
            sub="Alert immediately when one tool call reaches the model-visible output cap and is truncated."
            source={sourceBadge(toolOutputAlerts.outputCapHitsEnabled)}
            control={
              <SettingsSwitch
                checked={toolOutputAlerts.outputCapHitsEnabled.value}
                disabled={props.saving}
                label="Tool output reaches the cap"
                onChange={(next) => {
                  void props.onToolOutputAlertsChange({
                    outputCapHitsEnabled: next,
                  });
                }}
              />
            }
          />
          <SettingsField
            label="Repeated large tool outputs"
            sub="Alert after five tool calls in one turn each produce at least 50% of the model-visible output cap."
            source={sourceBadge(toolOutputAlerts.repeatedLargeOutputsEnabled)}
            control={
              <SettingsSwitch
                checked={toolOutputAlerts.repeatedLargeOutputsEnabled.value}
                disabled={props.saving}
                label="Repeated large tool outputs"
                onChange={(next) => {
                  void props.onToolOutputAlertsChange({
                    repeatedLargeOutputsEnabled: next,
                  });
                }}
              />
            }
          />
          <SettingsField
            label="Repeated queued checks"
            sub="Alert when repeated wait or polling calls keep waking the model and replaying the turn context."
            source={sourceBadge(toolOutputAlerts.repeatedQueuedChecksEnabled)}
            control={
              <SettingsSwitch
                checked={toolOutputAlerts.repeatedQueuedChecksEnabled.value}
                disabled={props.saving}
                label="Repeated queued checks"
                onChange={(next) => {
                  void props.onToolOutputAlertsChange({
                    repeatedQueuedChecksEnabled: next,
                  });
                }}
              />
            }
          />
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}
