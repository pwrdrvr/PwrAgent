import type { ReactNode } from "react";

/**
 * Layout primitives for settings screens. New settings should compose
 * <SettingsSection> + <SettingsRow> rather than rolling their own panel
 * markup so that layout, spacing, inline help, and accessibility stay
 * consistent as we add more settings.
 *
 * Existing settings panels predate these primitives and continue to use
 * the legacy .settings-panel / .settings-row CSS classes — both styles
 * coexist and read the same in the shell.
 */

export function SettingsSection(props: {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const headingId = `settings-section-${props.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

  return (
    <section
      aria-labelledby={headingId}
      aria-label={props["aria-label"]}
      className="settings-panel"
    >
      <div className="settings-panel__header">
        <div>
          {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
          <h2 id={headingId}>{props.title}</h2>
          {props.description ? (
            <p className="settings-section__description">{props.description}</p>
          ) : null}
        </div>
      </div>
      <div className="settings-section__body">{props.children}</div>
    </section>
  );
}

export function SettingsRow(props: {
  label: string;
  /** Optional inline help text rendered under the label. */
  help?: ReactNode;
  /** Control element (input, select, button, etc.). */
  control: ReactNode;
  /**
   * Render the control inline with the label instead of stacked. Default
   * stacked layout matches the current .settings-row treatment for
   * complex controls.
   */
  inline?: boolean;
  /** Optional inline error message rendered under the control. */
  error?: ReactNode;
}) {
  return (
    <div
      className={`settings-row${props.inline ? " settings-row--inline" : ""}`}
    >
      <div className="settings-row__label">
        <span className="settings-row__label-text">{props.label}</span>
        {props.help ? (
          <span className="settings-row__help">{props.help}</span>
        ) : null}
      </div>
      <div className="settings-row__control">{props.control}</div>
      {props.error ? (
        <p className="settings-row__error" role="alert">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
