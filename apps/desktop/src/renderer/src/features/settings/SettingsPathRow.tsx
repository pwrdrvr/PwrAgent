import type { ReactNode } from "react";
import type { SettingsChipTone } from "./SettingsLayout";

export interface SettingsPathRowChip {
  label: ReactNode;
  /** Visual tone — see `SettingsChipTone` for the shared vocabulary. */
  tone?: SettingsChipTone;
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
 *
 * One row layout, two callsites. Replaces `.settings-discovery__row`
 * and `.settings-application` markup.
 */
export function SettingsPathRow(props: {
  /** Optional left icon — image, glyph, or fallback letter. */
  icon?: ReactNode;
  /** Bold primary text (e.g. "VS Code", or path when no separate path). */
  title?: ReactNode;
  /** Mono secondary path beneath the title. */
  path?: string;
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
  /** When omitted, no action button renders (caller handles it elsewhere). */
  onUse?: () => void;
}) {
  const useLabel = props.useLabel ?? "Use";
  const selectedLabel = props.selectedLabel ?? "Selected";

  return (
    <div
      className={`settings-pathrow${props.selected ? " is-selected" : ""}`}
    >
      {props.icon ? (
        <span className="settings-pathrow__icon">{props.icon}</span>
      ) : null}
      <div className="settings-pathrow__body">
        {props.title ? (
          <span className="settings-pathrow__title">{props.title}</span>
        ) : null}
        {props.path ? (
          <span className="settings-pathrow__path">{props.path}</span>
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
              >
                {chip.label}
              </span>
            );
          })}
        </div>
      ) : null}
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
