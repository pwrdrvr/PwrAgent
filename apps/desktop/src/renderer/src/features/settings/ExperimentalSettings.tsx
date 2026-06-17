import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionGroup,
  SettingsSectionStack,
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";
import { sourceBadge } from "./settings-fields";

/**
 * Diff condensation runs an xAI judgment call on each "focused diff"
 * request to decide which hunks to hide. Defaults to OFF so we don't
 * send xAI requests on every diff render unless the user opts in.
 *
 * "auto" picks the model that matches the active backend (Codex backend
 * uses a Codex-shaped model, Grok backend uses a Grok model). Pinning a
 * specific model overrides that — every condensation request will use
 * the chosen model regardless of which backend is active.
 */
const DIFF_CONDENSATION_MODEL_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "Auto (match backend)", value: "auto" },
  { label: "grok-4-fast-reasoning", value: "grok-4-fast-reasoning" },
  { label: "grok-4-fast", value: "grok-4-fast" },
  { label: "grok-3-mini", value: "grok-3-mini" },
  { label: "grok-3", value: "grok-3" },
];

const DEFAULT_LIVE_TRANSCRIPT_EVENT_FILTERING = {
  value: false,
  source: "default" as const,
};

const DEFAULT_CODEX_DEFAULT_MODE_REQUEST_USER_INPUT = {
  value: false,
  source: "default" as const,
};

const DEFAULT_AGENT_CORE_GROK = {
  value: false,
  source: "default" as const,
};

const DEFAULT_THREAD_PRICING_SUMMARY = {
  value: false,
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

export function ExperimentalSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onDiffCondensationEnabledChange: (enabled: boolean) => Promise<void>;
  onDiffCondensationModelChange: (model: string) => Promise<void>;
  onLiveTranscriptEventFilteringChange: (enabled: boolean) => Promise<void>;
  onThreadPricingSummaryChange: (enabled: boolean) => Promise<void>;
  onThreadPricingDisplayUsdChange: (enabled: boolean) => Promise<void>;
  onThreadPricingDisplayCodexCreditsChange: (enabled: boolean) => Promise<void>;
  onCodexDefaultModeRequestUserInputChange: (
    enabled: boolean,
  ) => Promise<void>;
  onAgentCoreGrokChange: (enabled: boolean) => Promise<void>;
}) {
  const condensation = props.snapshot.experimental.diffCondensation;
  const liveTranscriptEventFiltering =
    props.snapshot.experimental.liveTranscriptEventFiltering ??
    DEFAULT_LIVE_TRANSCRIPT_EVENT_FILTERING;
  const threadPricingSummary =
    props.snapshot.experimental.threadPricingSummary ??
    DEFAULT_THREAD_PRICING_SUMMARY;
  const threadPricingDisplayUsd =
    props.snapshot.experimental.threadPricingDisplayUsd ??
    DEFAULT_THREAD_PRICING_DISPLAY_USD;
  const threadPricingDisplayCodexCredits =
    props.snapshot.experimental.threadPricingDisplayCodexCredits ??
    DEFAULT_THREAD_PRICING_DISPLAY_CODEX_CREDITS;
  const codexDefaultModeRequestUserInput =
    props.snapshot.experimental.codexDefaultModeRequestUserInput ??
    DEFAULT_CODEX_DEFAULT_MODE_REQUEST_USER_INPUT;
  const agentCoreGrok =
    props.snapshot.experimental.agentCoreGrok ?? DEFAULT_AGENT_CORE_GROK;
  const knownCondensationModel = DIFF_CONDENSATION_MODEL_OPTIONS.some(
    (option) => option.value === condensation.model.value,
  );
  const discontinuedEnabledCount =
    (condensation.enabled.value ? 1 : 0) +
    (agentCoreGrok.value ? 1 : 0) +
    (liveTranscriptEventFiltering.value ? 1 : 0);

  return (
    <SettingsSectionStack paneId="experimental" aria-label="Experimental settings">
      <SettingsPanelHead
        eyebrow="Experimental"
        title="Experimental features"
        help="Opt-in features that may change shape or be removed without notice."
      />

      <SettingsSection
        eyebrow="Experimental"
        title="Thread Pricing Summary"
        description="Show list-price usage totals in the thread context rail. Disabled by default while pricing reconstruction and provider coverage are being validated."
        chip={threadPricingSummary.value ? "On" : "Off"}
        chipKind={threadPricingSummary.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Enable thread pricing summary"
            sub="When on, the Pricing tab appears in the thread context rail with list-price totals and per-turn usage rows."
            source={sourceBadge(threadPricingSummary)}
            control={
              <SettingsSwitch
                checked={threadPricingSummary.value}
                disabled={props.saving}
                label="Enable thread pricing summary"
                onChange={(enabled) => {
                  void props.onThreadPricingSummaryChange(enabled);
                }}
              />
            }
          />
          <SettingsField
            label="Display USD"
            sub="Show OpenAI API list-price estimates in USD."
            source={sourceBadge(threadPricingDisplayUsd)}
            control={
              <SettingsSwitch
                checked={threadPricingDisplayUsd.value}
                disabled={props.saving || !threadPricingSummary.value}
                label="Display USD"
                onChange={(enabled) => {
                  void props.onThreadPricingDisplayUsdChange(enabled);
                }}
              />
            }
          />
          <SettingsField
            label="Display Codex Credits"
            sub="Show Codex Credits estimates from Codex's token-based credit rate card."
            source={sourceBadge(threadPricingDisplayCodexCredits)}
            control={
              <SettingsSwitch
                checked={threadPricingDisplayCodexCredits.value}
                disabled={props.saving || !threadPricingSummary.value}
                label="Display Codex Credits"
                onChange={(enabled) => {
                  void props.onThreadPricingDisplayCodexCreditsChange(enabled);
                }}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Experimental"
        title="Codex Skill Questions"
        description="Allow Codex skills to pause ordinary turns for structured questions when the installed Codex build supports default-mode request_user_input."
        chip={codexDefaultModeRequestUserInput.value ? "On" : "Off"}
        chipKind={codexDefaultModeRequestUserInput.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Enable Codex skill questions"
            sub="When on, PwrAgent enables Codex's default-mode request_user_input feature for Codex threads."
            source={sourceBadge(codexDefaultModeRequestUserInput)}
            control={
              <SettingsSwitch
                checked={codexDefaultModeRequestUserInput.value}
                disabled={props.saving}
                label="Enable Codex skill questions"
                onChange={(enabled) => {
                  void props.onCodexDefaultModeRequestUserInputChange(enabled);
                }}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSectionGroup
        groupId="experimental-discontinued"
        eyebrow="Deprecated"
        title="Soon to be discontinued"
        description="These features are being phased out and may be removed in a future release."
        chip={discontinuedEnabledCount > 0 ? `${discontinuedEnabledCount} on` : "All off"}
        chipKind={discontinuedEnabledCount > 0 ? "ok" : "default"}
        defaultCollapsed
        aria-label="Soon to be discontinued experimental settings"
      >
        <SettingsSection
          eyebrow="Experimental"
          title="Diff Condensation"
          description="Send focused-diff hunks to xAI for a judgment call on what to hide. Disabled by default — every diff renders in full and no xAI request fires."
          chip={condensation.enabled.value ? "On" : "Off"}
          chipKind={condensation.enabled.value ? "ok" : "default"}
        >
          <div className="settings-fields">
            <SettingsField
              label="Enable diff condensation"
              sub="When on, focused-diff requests fire an xAI judgment call to decide which hunks to elide."
              source={sourceBadge(condensation.enabled)}
              control={
                <SettingsSwitch
                  checked={condensation.enabled.value}
                  disabled={props.saving}
                  label="Enable diff condensation"
                  onChange={(enabled) => {
                    void props.onDiffCondensationEnabledChange(enabled);
                  }}
                />
              }
            />

            <SettingsField
              label="Eliding model"
              sub="Which model decides which hunks to elide."
              help="Auto matches the thread's primary backend. Pinning a specific model uses it for every eliding request, regardless of backend."
              source={sourceBadge(condensation.model)}
              control={
                <div
                  className="settings-segmented"
                  role="radiogroup"
                  aria-label="Diff condensation model"
                >
                  {DIFF_CONDENSATION_MODEL_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      aria-checked={condensation.model.value === option.value}
                      className={`settings-segmented__button${
                        condensation.model.value === option.value ? " is-active" : ""
                      }`}
                      disabled={props.saving || !condensation.enabled.value}
                      role="radio"
                      type="button"
                      onClick={() => {
                        void props.onDiffCondensationModelChange(option.value);
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                  {!knownCondensationModel ? (
                    <button
                      aria-checked
                      className="settings-segmented__button is-active"
                      disabled
                      role="radio"
                      type="button"
                    >
                      {condensation.model.value} (custom)
                    </button>
                  ) : null}
                </div>
              }
            />
          </div>
        </SettingsSection>

        <SettingsSection
          eyebrow="Experimental"
          title="AgentCore - Grok"
          description="Legacy direct-xAI Grok backend. Disabled by default. Prefer the Grok CLI (ACP) backend instead — set up under Settings → ACP Agents."
          chip={agentCoreGrok.value ? "On" : "Off"}
          chipKind={agentCoreGrok.value ? "ok" : "default"}
        >
          <div className="settings-fields">
            <SettingsField
              label="Enable AgentCore - Grok"
              sub="When on, the legacy agent-core Grok backend appears in the backend picker. Uses the Grok API key from Settings → Models → Grok."
              source={sourceBadge(agentCoreGrok)}
              control={
                <SettingsSwitch
                  checked={agentCoreGrok.value}
                  disabled={props.saving}
                  label="Enable AgentCore - Grok"
                  onChange={(enabled) => {
                    void props.onAgentCoreGrokChange(enabled);
                  }}
                />
              }
            />
          </div>
        </SettingsSection>

        <SettingsSection
          eyebrow="Experimental"
          title="Live Transcript Event Filtering"
          description="Reduce renderer work from live transcript notifications by ignoring unrelated thread-local events and skipping duplicate activity updates. Disabled by default."
          chip={liveTranscriptEventFiltering.value ? "On" : "Off"}
          chipKind={liveTranscriptEventFiltering.value ? "ok" : "default"}
        >
          <div className="settings-fields">
            <SettingsField
              label="Enable live transcript event filtering"
              sub="When on, live transcript notifications for other threads no longer update the focused thread view."
              source={sourceBadge(liveTranscriptEventFiltering)}
              control={
                <SettingsSwitch
                  checked={liveTranscriptEventFiltering.value}
                  disabled={props.saving}
                  label="Enable live transcript event filtering"
                  onChange={(enabled) => {
                    void props.onLiveTranscriptEventFilteringChange(enabled);
                  }}
                />
              }
            />
          </div>
        </SettingsSection>
      </SettingsSectionGroup>
    </SettingsSectionStack>
  );
}
