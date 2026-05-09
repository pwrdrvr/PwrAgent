import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
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

export function ExperimentalSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onDiffCondensationEnabledChange: (enabled: boolean) => Promise<void>;
  onDiffCondensationModelChange: (model: string) => Promise<void>;
}) {
  const condensation = props.snapshot.experimental.diffCondensation;
  const knownCondensationModel = DIFF_CONDENSATION_MODEL_OPTIONS.some(
    (option) => option.value === condensation.model.value,
  );

  return (
    <SettingsSectionStack paneId="experimental" aria-label="Experimental settings">
      <SettingsPanelHead
        eyebrow="Experimental"
        title="Experimental features"
        help="Opt-in features that may change shape or be removed without notice."
      />

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
    </SettingsSectionStack>
  );
}
