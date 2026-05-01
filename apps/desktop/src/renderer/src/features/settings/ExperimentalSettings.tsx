import type { DesktopChatReplyComposer, DesktopSettingsSnapshot } from "@pwragnt/shared";
import { sourceBadge } from "./settings-fields";

const COMPOSER_OPTIONS: Array<{
  label: string;
  value: DesktopChatReplyComposer;
}> = [
  { label: "Textarea", value: "textarea" },
  { label: "TipTap raw Markdown + chips", value: "tiptap-chips" },
  {
    label: "TipTap WYSIWYG Markdown + chips",
    value: "tiptap-wysiwyg-markdown-chips",
  },
  { label: "Custom widget with chips", value: "custom-widget-chips" },
];

export function ExperimentalSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onComposerChange: (value: DesktopChatReplyComposer) => Promise<void>;
}) {
  const composer = props.snapshot.experimental.chatReplyComposer;

  return (
    <section className="settings-panel" aria-labelledby="settings-experimental-title">
      <div className="settings-panel__header">
        <div>
          <p className="eyebrow">Experimental</p>
          <h2 id="settings-experimental-title">Chat Reply Composer</h2>
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
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
