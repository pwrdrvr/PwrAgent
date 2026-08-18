import type {
  DesktopSettingsSnapshot,
  DesktopSpendAlertPolicy,
  DesktopToolOutputAlertPolicy,
} from "@pwragent/shared";
import {
  MAX_REPEATED_LARGE_OUTPUT_CALLS,
  MAX_REPEATED_LARGE_OUTPUT_PERCENT,
  MAX_SPEND_ALERT_THRESHOLD_USD,
  MIN_REPEATED_LARGE_OUTPUT_CALLS,
  MIN_REPEATED_LARGE_OUTPUT_PERCENT,
  MIN_SPEND_ALERT_THRESHOLD_USD,
} from "@pwragent/shared";
import { useEffect, useState } from "react";
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

const DEFAULT_TOKEN_MISER_ENABLED = {
  value: false,
  source: "default" as const,
};

export function PricingSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onThreadPricingSummaryChange: (enabled: boolean) => Promise<void>;
  onThreadPricingDisplayUsdChange: (enabled: boolean) => Promise<void>;
  onThreadPricingDisplayCodexCreditsChange: (enabled: boolean) => Promise<void>;
  onTokenMiserEnabledChange: (enabled: boolean) => Promise<void>;
  onSpendAlertsChange: (
    patch: Partial<DesktopSpendAlertPolicy>,
  ) => Promise<void>;
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
  const tokenMiserEnabled =
    props.snapshot.general.tokenMiserEnabled ?? DEFAULT_TOKEN_MISER_ENABLED;
  const tokenMiserUsage = props.snapshot.runtime.tokenMiser;
  const tokenMiserActivation = tokenMiserUsage?.activation;
  // Only a contradiction is worth reporting: switched on, but the Codex side
  // never loaded. Off-and-unavailable is just off.
  const tokenMiserInert =
    tokenMiserEnabled.value && tokenMiserActivation?.state === "unavailable";
  const spendAlerts = props.snapshot.general.spendAlerts;
  const alertsEnabled =
    spendAlerts.activeTurnSpendEnabled.value
    || spendAlerts.threadSpendEnabled.value
    || toolOutputAlerts.outputCapHitsEnabled.value
    || toolOutputAlerts.repeatedLargeOutputsEnabled.value
    || toolOutputAlerts.repeatedQueuedChecksEnabled.value;
  const displayControlsDisabled = props.saving || !threadPricingSummary.value;
  const repeatedLargeOutputDescription =
    `Alert after ${toolOutputAlerts.repeatedLargeOutputMinimumCalls.value.toLocaleString()} tool calls in one turn each produce at least ${toolOutputAlerts.repeatedLargeOutputMinimumPercent.value.toLocaleString()}% of the model-visible output cap.`;

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
        title="Token Miser"
        description="Keep accidental walls of Codex tool output out of the parent thread while preserving the exact result for targeted retrieval."
        chip={tokenMiserInert ? "Not running" : tokenMiserEnabled.value ? "On" : "Off"}
        chipKind={
          tokenMiserInert
            ? "warn"
            : tokenMiserEnabled.value ? "ok" : "default"
        }
      >
        <div className="settings-fields">
          <SettingsField
            label="Intercept large Codex tool output"
            sub="For results over 5,000 characters, use GPT-5.6-Luna at medium effort to return a compact summary plus search and line-range retrieval tools."
            help="Off by default. Codex requires you to approve the exact PwrAgent hook with /hooks before it can run. New or reloaded Codex threads pick up the hook after approval. If the bridge or summarizer is unavailable, the original result passes through unchanged."
            source={sourceBadge(tokenMiserEnabled)}
            control={
              <SettingsSwitch
                checked={tokenMiserEnabled.value}
                disabled={props.saving}
                label="Intercept large Codex tool output"
                onChange={(enabled) => {
                  void props.onTokenMiserEnabledChange(enabled);
                }}
              />
            }
          />
          {tokenMiserInert ? (
            <SettingsField
              label="Codex could not load the gate"
              sub={tokenMiserActivation?.reason
                ?? "Codex plugin activation did not complete."}
              help="Token Miser fails open, so turns keep running with tool output unchanged — nothing is gated until this clears. PwrAgent retries activation each time a Codex backend starts, so relaunching after fixing the cause is usually enough."
              control={
                <span className="settings-field__value settings-field__value--warn">
                  Enabled, not running
                </span>
              }
            />
          ) : null}
          {tokenMiserUsage && tokenMiserUsage.interceptionCount > 0 ? (
            <SettingsField
              label="Estimated parent-context savings"
              sub={`${tokenMiserUsage.interceptionCount.toLocaleString()} intercepted results · ${tokenMiserUsage.baselineParentTokens.toLocaleString()} baseline tokens − ${tokenMiserUsage.replacementTokens.toLocaleString()} summary tokens − ${tokenMiserUsage.retrievedTokens.toLocaleString()} retrieved tokens.`}
              help="This estimate measures tokens kept out of the parent thread after Codex's model-visible output cap. It is separate from the Luna helper's own token cost. Repeated retrievals count each time, so reading everything can make the savings negative."
              control={
                <span className="settings-field__value">
                  {tokenMiserUsage.estimatedParentTokensSaved >= 0 ? "Saved " : "Added "}
                  {Math.abs(
                    tokenMiserUsage.estimatedParentTokensSaved,
                  ).toLocaleString()} tokens
                </span>
              }
            />
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Usage"
        title="Alerts"
        description="Choose which costly or lossy tool-use patterns should interrupt you."
        chip={alertsEnabled ? "On" : "Off"}
        chipKind={alertsEnabled ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Active turn spend"
            sub={`Alert when one active turn reaches $${spendAlerts.activeTurnSpendThresholdUsd.value.toFixed(2)} in estimated list-price spend.`}
            source={sourceBadge(spendAlerts.activeTurnSpendEnabled)}
            control={
              <SettingsSwitch
                checked={spendAlerts.activeTurnSpendEnabled.value}
                disabled={props.saving}
                label="Active turn spend"
                onChange={(next) => {
                  void props.onSpendAlertsChange({
                    activeTurnSpendEnabled: next,
                  });
                }}
              />
            }
          />
          <AlertNumberField
            decimals={2}
            disabled={
              props.saving || !spendAlerts.activeTurnSpendEnabled.value
            }
            label="Active turn spend threshold"
            max={MAX_SPEND_ALERT_THRESHOLD_USD}
            min={MIN_SPEND_ALERT_THRESHOLD_USD}
            source={sourceBadge(spendAlerts.activeTurnSpendThresholdUsd)}
            step={0.01}
            sub="Estimated list-price spend allowed for one active turn before the alert is raised."
            suffix="USD"
            value={spendAlerts.activeTurnSpendThresholdUsd.value}
            onSave={(next) => {
              void props.onSpendAlertsChange({
                activeTurnSpendThresholdUsd: next,
              });
            }}
          />
          <SettingsField
            label="Total thread spend"
            sub={`Alert when a thread reaches $${spendAlerts.threadSpendThresholdUsd.value.toFixed(2)} in estimated list-price spend.`}
            source={sourceBadge(spendAlerts.threadSpendEnabled)}
            control={
              <SettingsSwitch
                checked={spendAlerts.threadSpendEnabled.value}
                disabled={props.saving}
                label="Total thread spend"
                onChange={(next) => {
                  void props.onSpendAlertsChange({
                    threadSpendEnabled: next,
                  });
                }}
              />
            }
          />
          <AlertNumberField
            decimals={2}
            disabled={props.saving || !spendAlerts.threadSpendEnabled.value}
            label="Total thread spend threshold"
            max={MAX_SPEND_ALERT_THRESHOLD_USD}
            min={MIN_SPEND_ALERT_THRESHOLD_USD}
            source={sourceBadge(spendAlerts.threadSpendThresholdUsd)}
            step={0.01}
            sub="Estimated list-price spend allowed across the thread before the alert is raised."
            suffix="USD"
            value={spendAlerts.threadSpendThresholdUsd.value}
            onSave={(next) => {
              void props.onSpendAlertsChange({
                threadSpendThresholdUsd: next,
              });
            }}
          />
          <SettingsField
            label="Tool output reaches the cap"
            sub="Alert immediately when one tool call reaches the model-visible output cap and is truncated. This trigger does not use the calls-per-turn setting."
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
            sub={repeatedLargeOutputDescription}
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
          <AlertNumberField
            disabled={
              props.saving
              || !toolOutputAlerts.repeatedLargeOutputsEnabled.value
            }
            label="Calls per turn"
            max={MAX_REPEATED_LARGE_OUTPUT_CALLS}
            min={MIN_REPEATED_LARGE_OUTPUT_CALLS}
            source={sourceBadge(
              toolOutputAlerts.repeatedLargeOutputMinimumCalls,
            )}
            sub="Number of qualifying calls required for Repeated large tool outputs. Cap-hit alerts remain immediate."
            suffix="calls"
            value={toolOutputAlerts.repeatedLargeOutputMinimumCalls.value}
            onSave={(next) => {
              void props.onToolOutputAlertsChange({
                repeatedLargeOutputMinimumCalls: next,
              });
            }}
          />
          <AlertNumberField
            disabled={
              props.saving
              || !toolOutputAlerts.repeatedLargeOutputsEnabled.value
            }
            label="Output size threshold"
            max={MAX_REPEATED_LARGE_OUTPUT_PERCENT}
            min={MIN_REPEATED_LARGE_OUTPUT_PERCENT}
            source={sourceBadge(
              toolOutputAlerts.repeatedLargeOutputMinimumPercent,
            )}
            sub="Each qualifying call must produce at least this share of the model-visible output cap."
            suffix="% of cap"
            value={toolOutputAlerts.repeatedLargeOutputMinimumPercent.value}
            onSave={(next) => {
              void props.onToolOutputAlertsChange({
                repeatedLargeOutputMinimumPercent: next,
              });
            }}
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

function AlertNumberField(props: {
  decimals?: number;
  disabled?: boolean;
  label: string;
  max: number;
  min: number;
  source: string;
  step?: number;
  sub: string;
  suffix: string;
  value: number;
  onSave: (value: number) => void;
}) {
  const [value, setValue] = useState(String(props.value));

  useEffect(() => {
    setValue(String(props.value));
  }, [props.value]);

  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      source={props.source}
      control={
        <span className="settings-number">
          <input
            aria-label={props.label}
            className="settings-input settings-input--inline"
            disabled={props.disabled}
            max={props.max}
            min={props.min}
            step={props.step}
            type="number"
            value={value}
            onBlur={() => {
              const parsed = Number(value);
              if (!Number.isFinite(parsed)) {
                setValue(String(props.value));
                return;
              }
              const normalized = props.decimals === undefined
                ? Math.trunc(parsed)
                : Number(parsed.toFixed(props.decimals));
              const clamped = Math.min(
                Math.max(normalized, props.min),
                props.max,
              );
              setValue(String(clamped));
              if (clamped !== props.value) {
                props.onSave(clamped);
              }
            }}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <span className="settings-source">{props.suffix}</span>
        </span>
      }
    />
  );
}
