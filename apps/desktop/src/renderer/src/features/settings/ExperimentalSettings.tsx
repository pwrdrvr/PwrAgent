import type { DesktopChatReplyComposer, DesktopSettingsSnapshot } from "@pwragent/shared";
import { sourceBadge } from "./settings-fields";

const COMPOSER_OPTIONS: Array<{
  default?: boolean;
  label: string;
  value: DesktopChatReplyComposer;
}> = [
  { label: "Textarea", value: "textarea" },
  { label: "TipTap raw Markdown + chips", value: "tiptap-chips" },
  {
    default: true,
    label: "TipTap WYSIWYG Markdown + chips",
    value: "tiptap-wysiwyg-markdown-chips",
  },
  { label: "Custom widget with chips", value: "custom-widget-chips" },
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
      <section
        className="settings-panel"
        aria-labelledby="settings-experimental-composer-title"
      >
        <div className="settings-panel__header">
          <div>
            <p className="eyebrow">Experimental</p>
            <h2 id="settings-experimental-composer-title">Chat Reply Composer</h2>
          </div>
          <span className="settings-source">{sourceBadge(composer)}</span>
        </div>

        <div className="settings-field">
          <div
            className="settings-segmented"
            role="radiogroup"
            aria-label="Chat Reply Composer"
          >
            {COMPOSER_OPTIONS.map((option) => (
              <button
                key={option.value}
                aria-checked={composer.value === option.value}
                className={`settings-segmented__button${
                  composer.value === option.value ? " is-active" : ""
                }`}
                disabled={props.saving}
                role="radio"
                type="button"
                onClick={() => {
                  void props.onComposerChange(option.value);
                }}
              >
                <span>{option.label}</span>
                {option.default ? (
                  <span aria-hidden="true" className="settings-segmented__meta">
                    Default
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section
        className="settings-panel"
        aria-labelledby="settings-experimental-diff-condensation-title"
      >
        <div className="settings-panel__header">
          <div>
            <p className="eyebrow">Experimental</p>
            <h2 id="settings-experimental-diff-condensation-title">
              Diff Condensation
            </h2>
            <p className="settings-section__description">
              Send focused-diff hunks to xAI for a judgment call on what to
              hide. Disabled by default — every diff renders in full and no
              xAI request fires.
            </p>
          </div>
          <span className="settings-source">{sourceBadge(condensation.enabled)}</span>
        </div>

        <label className="settings-row settings-row--toggle">
          <span>
            <span className="settings-row__label">Enable diff condensation</span>
            <span className="settings-source">{sourceBadge(condensation.enabled)}</span>
          </span>
          <input
            aria-label="Enable diff condensation"
            checked={condensation.enabled.value}
            disabled={props.saving}
            type="checkbox"
            onChange={(event) => {
              void props.onDiffCondensationEnabledChange(event.currentTarget.checked);
            }}
          />
        </label>

        <div className="settings-row">
          <div className="settings-row__label">
            <span className="settings-row__label-text">Model</span>
            <span className="settings-row__help">
              <strong>Auto</strong> uses the model that matches the active
              backend. Pin a specific model to use it for every condensation
              request, regardless of backend.
            </span>
          </div>
          <select
            aria-label="Diff condensation model"
            disabled={props.saving || !condensation.enabled.value}
            value={condensation.model.value}
            onChange={(event) => {
              void props.onDiffCondensationModelChange(event.currentTarget.value);
            }}
          >
            {DIFF_CONDENSATION_MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {!knownCondensationModel ? (
              <option value={condensation.model.value}>
                {condensation.model.value} (custom)
              </option>
            ) : null}
          </select>
        </div>
      </section>
    </section>
  );
}
