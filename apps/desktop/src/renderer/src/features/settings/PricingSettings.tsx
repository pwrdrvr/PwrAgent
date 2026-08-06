import type { DesktopSettingsSnapshot } from "@pwragent/shared";
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
  const displayControlsDisabled = props.saving || !threadPricingSummary.value;

  return (
    <SettingsSectionStack paneId="pricing" aria-label="Usage and pricing settings">
      <SettingsPanelHead
        eyebrow="Pricing"
        title="Usage & pricing"
        help="Control how estimated thread usage costs are shown."
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
            help="Dollars use OpenAI API list prices. Codex Credits use Codex's token-based credit rate card."
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
                  Dollars
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
    </SettingsSectionStack>
  );
}
