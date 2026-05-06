import type { DesktopChatReplyComposer, DesktopSettingsSnapshot } from "@pwragent/shared";
import {
  SettingsCompOption,
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";
import { sourceBadge } from "./settings-fields";

const COMPOSER_OPTIONS: Array<{
  default?: boolean;
  label: string;
  sub: string;
  value: DesktopChatReplyComposer;
}> = [
  {
    label: "Textarea",
    sub: "Native textarea reply composer. No formatting, no chips. Smallest surface, most predictable.",
    value: "textarea",
  },
  {
    label: "TipTap raw Markdown + chips",
    sub: "TipTap editor that shows the Markdown source. Slash menu inserts chips for models, worktrees, and access modes.",
    value: "tiptap-chips",
  },
  {
    default: true,
    label: "TipTap WYSIWYG Markdown + chips",
    sub: "Renders Markdown as you type. Bold, links, lists, and chips appear inline. The default for new users.",
    value: "tiptap-wysiwyg-markdown-chips",
  },
  {
    label: "Custom widget with chips",
    sub: "In-house composer built around chip primitives. No Markdown parser; chips are first-class tokens.",
    value: "custom-widget-chips",
  },
];

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
  onComposerChange: (value: DesktopChatReplyComposer) => Promise<void>;
  onDiffCondensationEnabledChange: (enabled: boolean) => Promise<void>;
  onDiffCondensationModelChange: (model: string) => Promise<void>;
}) {
  const composer = props.snapshot.experimental.chatReplyComposer;
  const condensation = props.snapshot.experimental.diffCondensation;
  const knownCondensationModel = DIFF_CONDENSATION_MODEL_OPTIONS.some(
    (option) => option.value === condensation.model.value,
  );

  return (
    <section className="settings-stack" aria-label="Experimental settings">
      <SettingsPanelHead
        eyebrow="Experimental"
        title="Experimental features"
        help="Opt-in features that may change shape or be removed without notice."
      />

      <SettingsSection
        eyebrow="Experimental"
        title="Chat Reply Composer"
        chip={sourceBadge(composer)}
        chipKind={composer.source === "env" ? "warn" : "default"}
      >
        <div
          className="settings-comp-opts"
          role="radiogroup"
          aria-label="Chat Reply Composer"
        >
          {COMPOSER_OPTIONS.map((option) => (
            <SettingsCompOption
              key={option.value}
              value={option.value}
              title={option.label}
              sub={option.sub}
              isDefault={option.default}
              active={composer.value === option.value}
              disabled={props.saving}
              onSelect={(value) => {
                void props.onComposerChange(value);
              }}
            />
          ))}
        </div>
      </SettingsSection>

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
    </section>
  );
}
