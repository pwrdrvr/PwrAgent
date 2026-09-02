import type { ReactNode } from "react";
import type { SettingsChipTone } from "./SettingsLayout";

export interface SettingsPathRowChip {
  label: ReactNode;
  /** Visual tone — see `SettingsChipTone` for the shared vocabulary. */
  tone?: SettingsChipTone;
  /** Hover text, for a chip whose full meaning does not fit its label. */
  title?: string;
  /**
   * Stable key for React reconciliation. If a caller mutates the
   * chip array between renders (reorder, splice), passing a key keeps
   * React from mis-attaching state to the wrong chip. Falls back to
   * `tone-index` when omitted, which is fine for the current usage
   * (chip arrays built fresh each render).
   */
  key?: string;
}

/**
 * Canonical row primitive used by:
 * - Codex discovery (path candidates with version + source chip)
 * - Editor / Terminal application lists (icon + name + path + Use button)
 * - git / gh command lists (icon + provenance + version + path + trust)
 *
 * One row layout, several callsites. Replaces `.settings-discovery__row`
 * and `.settings-application` markup.
 *
 * ## Selecting
 *
 * Two ways to make a row choosable, and they are not interchangeable:
 *
 * - `onSelect` makes the **whole row** the control. Use it for a list of
 *   mutually exclusive candidates, which is what every one of these lists
 *   is. A row that looks like a choice should behave like one; before this
 *   existed only the trailing button was a hit target, so clicking the row
 *   did nothing.
 * - `onUse` keeps the trailing button as the only control. Use it when the
 *   row also carries an `extraAction`, since a button cannot nest inside a
 *   button.
 *
 * The selected row is deliberately NOT a control in either mode: it is
 * already the active choice, so there is nothing to activate. It renders
 * as a static element with a state chip, which also keeps it out of the
 * tab order.
 *
 * These lists are not marked up as an ARIA radiogroup. Selection here
 * writes config and re-runs discovery probes, and a radiogroup's arrow
 * keys move *selection*, which would fire that work on every keypress.
 * The rows are buttons in a labelled group, with `aria-current` marking
 * the live one.
 */
function wrapTitleLine(title: ReactNode, meta: string | undefined): ReactNode {
  if (!meta) return title;
  return (
    <span className="settings-pathrow__title-line">
      {title}
      <span className="settings-pathrow__meta">{meta}</span>
    </span>
  );
}

export function SettingsPathRow(props: {
  /** Optional left icon — image, glyph, or fallback letter. */
  icon?: ReactNode;
  /** Bold primary text (e.g. "VS Code", or path when no separate path). */
  title?: ReactNode;
  /** Small mono text beside the title — a version, typically. */
  meta?: string;
  /** Mono secondary path beneath the title. */
  path?: string;
  /**
   * Render `path` as wrapping prose rather than a single ellipsized line.
   * Set it when the value is a failure reason instead of a filesystem path.
   */
  pathIsDetail?: boolean;
  /** Right-side status chips (source / version / state). */
  chips?: SettingsPathRowChip[];
  /** Whether this row is the currently-active selection. */
  selected: boolean;
  /** Label for the right-side action button. Defaults to "Use". */
  useLabel?: string;
  /** Override the "Selected" chip text. Defaults to "Selected". */
  selectedLabel?: string;
  disabled?: boolean;
  /** Optional secondary action rendered before the selection/use action. */
  extraAction?: ReactNode;
  /**
   * Makes the entire row the selection control. Mutually exclusive with
   * `extraAction`, which would nest a button inside this one.
   */
  onSelect?: () => void;
  /**
   * Accessible name for the whole-row control. Without it the name is the
   * row's full text, which reads as an undifferentiated run of path,
   * version and chip labels.
   */
  selectLabel?: string;
  /** When omitted, no action button renders (caller handles it elsewhere). */
  onUse?: () => void;
}) {
  const useLabel = props.useLabel ?? "Use";
  const selectedLabel = props.selectedLabel ?? "Selected";
  const body = (
    <>
      {props.icon ? (
        <span className="settings-pathrow__icon">{props.icon}</span>
      ) : null}
      <div className="settings-pathrow__body">
        {props.title ? (
          // The title-line wrapper only appears when there is a `meta` to sit
          // beside the title. Every other caller keeps the original markup, so
          // adding the version slot cannot shift a row that does not use it.
          wrapTitleLine(
            <span
              // Truncation is only applied to a plain string, where `title`
              // below can carry the full value. An element title (the auth
              // profile rows pass one) composes its own inline layout, and
              // text-overflow does not apply to an atomic inline-flex box, so
              // ellipsizing it would hard-cut with nothing to hover.
              className={`settings-pathrow__title${
                typeof props.title === "string"
                  ? " settings-pathrow__title--truncate"
                  : ""
              }`}
              title={typeof props.title === "string" ? props.title : undefined}
            >
              {props.title}
            </span>,
            props.meta,
          )
        ) : null}
        {props.path ? (
          <span
            className={`settings-pathrow__path${
              props.pathIsDetail ? " settings-pathrow__path--detail" : ""
            }`}
            title={props.path}
          >
            {props.path}
          </span>
        ) : null}
      </div>
      {props.chips && props.chips.length > 0 ? (
        <div className="settings-pathrow__chips">
          {props.chips.map((chip, index) => {
            const toneClass =
              chip.tone && chip.tone !== "default" && chip.tone !== "muted"
                ? ` settings-pathrow__chip--${chip.tone}`
                : "";
            return (
              <span
                key={chip.key ?? `${chip.tone ?? "default"}-${index}`}
                className={`settings-pathrow__chip${toneClass}`}
                // Chips are width-capped, so a long label (a prerelease
                // version string) needs the full value reachable on hover.
                title={
                  chip.title
                    ?? (typeof chip.label === "string" ? chip.label : undefined)
                }
              >
                {chip.label}
              </span>
            );
          })}
        </div>
      ) : null}
    </>
  );

  if (props.onSelect && !props.selected && !props.extraAction) {
    return (
      <button
        aria-label={props.selectLabel}
        className="settings-pathrow settings-pathrow--selectable"
        disabled={props.disabled}
        type="button"
        onClick={props.onSelect}
      >
        {body}
        <span className="settings-pathrow__action settings-pathrow__use">
          {useLabel}
        </span>
      </button>
    );
  }

  return (
    <div
      aria-current={props.selected && props.onSelect ? "true" : undefined}
      className={`settings-pathrow${props.selected ? " is-selected" : ""}`}
    >
      {body}
      {props.extraAction ? (
        <span className="settings-pathrow__action">{props.extraAction}</span>
      ) : null}
      {props.selected ? (
        <span className="settings-pathrow__action settings-pathrow__chip settings-pathrow__chip--ok">
          {selectedLabel}
        </span>
      ) : props.onUse ? (
        <button
          className="button button--secondary settings-pathrow__action"
          disabled={props.disabled}
          type="button"
          onClick={props.onUse}
        >
          {useLabel}
        </button>
      ) : null}
    </div>
  );
}
