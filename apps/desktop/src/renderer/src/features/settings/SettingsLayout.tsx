import type { ReactNode } from "react";

/**
 * Layout primitives for settings screens. Compose `SettingsPanelHead`,
 * `SettingsSection`, `SettingsField`, and `SettingsCompOption` instead of
 * rolling per-pane markup so spacing, typography, and accessibility stay
 * consistent across panes.
 *
 * Visual contract follows the v2 design (see
 * `docs/design/pwragent-v2/project/settings.jsx` and `styles.css`):
 * - 22-px pane head (eyebrow + title + helper paragraph)
 * - cards with eyebrow + title + optional chip in head
 * - field rows with 220-px label column, label + sub stack on left
 * - composer-options as a vertical list with custom radio bullets
 */

/**
 * Shared chip-tone vocabulary used by both `SettingsSection.chipKind`
 * and `SettingsPathRowChip.tone`. Defined once here so the two
 * primitives can never drift apart.
 *
 * - `default`: neutral chip, panel-elevated background, muted text.
 * - `muted`: same neutrality as `default` — alias kept for callers
 *   whose semantics read better as "muted" (e.g. a path-row source
 *   tag like `application` / `path`).
 * - `ok`: success-tinted (configured, healthy, currently in use).
 * - `err`: danger-tinted (failed, unavailable).
 * - `warn`: accent-tinted (env override active, attention needed).
 */
export type SettingsChipTone = "default" | "muted" | "ok" | "err" | "warn";

export function SettingsPanelHead(props: {
  eyebrow: string;
  title: ReactNode;
  help?: ReactNode;
  /** Optional right-side action (e.g. "Check for updates" button). */
  action?: ReactNode;
}) {
  return (
    <header className="settings-head">
      <div className="settings-head__text">
        <p className="settings-head__eyebrow">{props.eyebrow}</p>
        <h1 className="settings-head__title">{props.title}</h1>
        {props.help ? (
          <p className="settings-head__help">{props.help}</p>
        ) : null}
      </div>
      {props.action ? (
        <div className="settings-head__action">{props.action}</div>
      ) : null}
    </header>
  );
}

export function SettingsSection(props: {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  children: ReactNode;
  /** Optional right-side chip in the card header. */
  chip?: ReactNode;
  chipKind?: SettingsChipTone;
  "aria-label"?: string;
}) {
  const headingId = `settings-section-${props.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

  const chipClass =
    props.chipKind && props.chipKind !== "default" && props.chipKind !== "muted"
      ? `settings-card__chip settings-card__chip--${props.chipKind}`
      : "settings-card__chip";

  return (
    <section
      aria-labelledby={headingId}
      aria-label={props["aria-label"]}
      className="settings-panel settings-panel--has-body"
    >
      <div className="settings-panel__header">
        <div>
          {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
          <h2 id={headingId}>{props.title}</h2>
          {props.description ? (
            <p className="settings-section__description">{props.description}</p>
          ) : null}
        </div>
        {props.chip ? <span className={chipClass}>{props.chip}</span> : null}
      </div>
      <div className="settings-section__body">{props.children}</div>
    </section>
  );
}

/**
 * 220-px label column field row. Replaces the legacy `SettingsRow` for
 * settings panes. Label + sub-line stack on left; control + help stack
 * on right.
 */
export function SettingsField(props: {
  /** Visible label adjacent to the control. Narrowed to `string` so
   *  the accessibility contract is explicit — empty/null/array would
   *  render a malformed label. */
  label: string;
  /** 12-px description below the label. Single sentence framing. */
  sub?: ReactNode;
  /** 11.5-px hint below the control. */
  help?: ReactNode;
  /** Optional source / status chip (existing `.settings-source` pill). */
  source?: ReactNode;
  control: ReactNode;
  /** Optional inline error message rendered under the control. */
  error?: ReactNode;
}) {
  return (
    <div className="settings-field">
      <div className="settings-field__label">
        <span>{props.label}</span>
        {props.sub ? (
          <span className="settings-field__sub">{props.sub}</span>
        ) : null}
        {props.source ? (
          <span className="settings-source">{props.source}</span>
        ) : null}
      </div>
      <div className="settings-field__control">
        {props.control}
        {props.help ? (
          <span className="settings-field__help">{props.help}</span>
        ) : null}
        {props.error ? (
          <p className="settings-row__error" role="alert">
            {props.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Composer-style radio card — used by Experimental → Reply Composer.
 * Renders as `<button role="radio">` so the existing test contract
 * (`getByRole("radio", { name: ... })`) continues to work.
 */
export function SettingsCompOption<TValue extends string>(props: {
  value: TValue;
  title: string;
  sub: string;
  isDefault?: boolean;
  active: boolean;
  disabled?: boolean;
  onSelect: (value: TValue) => void;
}) {
  return (
    <button
      aria-checked={props.active}
      aria-label={props.title}
      className={`settings-comp-opt${props.active ? " is-active" : ""}`}
      disabled={props.disabled}
      role="radio"
      type="button"
      onClick={() => props.onSelect(props.value)}
    >
      <span
        aria-hidden="true"
        className={`settings-comp-opt__radio${
          props.active ? " is-on" : ""
        }`}
      >
        {props.active ? <span className="settings-comp-opt__radio-dot" /> : null}
      </span>
      <span className="settings-comp-opt__text">
        <span className="settings-comp-opt__title">
          {props.title}
          {props.isDefault ? (
            <span aria-hidden="true" className="settings-comp-opt__defbadge">
              Default
            </span>
          ) : null}
        </span>
        <span className="settings-comp-opt__sub">{props.sub}</span>
      </span>
    </button>
  );
}
