import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  FIXED_KEYBINDINGS,
  KEYBINDING_ACTIONS,
  KEYBINDING_GROUPS,
  chordFromEvent,
  chordIdentity,
  defaultChordsFor,
  findActionUsingChord,
  formatChordLabel,
  getKeybindingAction,
  isActionChanged,
  isTextEditingChord,
  refuseChord,
  type KeybindingActionDefinition,
  type KeybindingActionId,
  type KeybindingWriteRequest,
} from "../../../../shared/keybindings";
import { SearchIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { useKeybindings, writeKeybindings } from "../../lib/keybindings-store";
import { SettingsCopyValue } from "./SettingsCopyValue";
import {
  SegmentedControl,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

type ShowFilter = "all" | "changed";

const SHOW_OPTIONS: Array<{ label: string; value: ShowFilter }> = [
  { label: "All", value: "all" },
  { label: "Changed", value: "changed" },
];

/** One action's recorder: what the operator is replacing, and what they pressed. */
type Recording = {
  actionId: KeybindingActionId;
  /** Change replaces every chord; Add keeps the current one beside it. */
  mode: "replace" | "add";
  /** The last chord pressed that could not be saved as it stands. */
  pressed?: {
    chord: string;
    refusal?: { title: string; reason: string };
    clashWith?: KeybindingActionId;
  };
};


/**
 * Settings › Keyboard: every shortcut, grouped, with a recorder for the ones
 * the operator can change. Changes go to `~/.pwragent/keybindings.toml`, which
 * every profile reads, so the page says so instead of naming a profile.
 */
export function KeyboardSettings(props: { desktopApi?: DesktopApi }) {
  const { bindings, platform, snapshot } = useKeybindings();
  const mac = platform === "darwin";
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<ShowFilter>("all");
  const [recording, setRecording] = useState<Recording>();
  const [rowErrors, setRowErrors] = useState<Partial<Record<KeybindingActionId, string>>>({});
  const [rowNotes, setRowNotes] = useState<Partial<Record<KeybindingActionId, string>>>({});
  const [resetAllError, setResetAllError] = useState<string>();
  const overrides = snapshot?.overrides ?? {};
  const label = (chord: string) => formatChordLabel(chord, platform);

  const save = async (actionId: KeybindingActionId, request: KeybindingWriteRequest): Promise<boolean> => {
    setRowErrors((current) => ({ ...current, [actionId]: undefined }));
    try {
      await writeKeybindings(request);
      return true;
    } catch (error) {
      setRowErrors((current) => ({
        ...current,
        [actionId]: error instanceof Error ? error.message : String(error),
      }));
      return false;
    }
  };

  const chordsOf = (actionId: KeybindingActionId) => bindings.get(actionId) ?? [];
  const sameChord = (left: string, right: string) =>
    chordIdentity(left, platform) === chordIdentity(right, platform);

  const commitChord = async (target: Recording, chord: string, takeFrom?: KeybindingActionId) => {
    const current = chordsOf(target.actionId);
    const next = target.mode === "add" ? [...current, chord] : [chord];
    if (takeFrom !== undefined) {
      // Unbind it from the other action first, so the file never holds the
      // chord twice.
      const remaining = chordsOf(takeFrom).filter((existing) => !sameChord(existing, chord));
      if (!(await save(takeFrom, { kind: "set", actionId: takeFrom, chords: remaining }))) return;
    }
    if (!(await save(target.actionId, { kind: "set", actionId: target.actionId, chords: next }))) return;
    setRecording(undefined);
    const action = getKeybindingAction(target.actionId);
    setRowNotes((current) => ({
      ...current,
      [target.actionId]: action?.firesInTextFields && isTextEditingChord(chord, platform)
        ? `${label(chord)} edits text in a field, so it does nothing while you type.`
        : undefined,
    }));
  };

  const recordKey = (event: KeyboardEvent<HTMLElement>, target: Recording) => {
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    // Tab leaves the recorder like any field; the blur cancels.
    if (plain && event.key === "Tab") return;
    // The recorder swallows every other key, including the chord it would
    // otherwise fire.
    event.preventDefault();
    event.stopPropagation();
    if (plain && event.key === "Escape") {
      setRecording(undefined);
      return;
    }
    const chord = chordFromEvent(event, platform);
    if (chord === null) return;
    const refusal = refuseChord(chord, platform);
    if (refusal !== null) {
      setRecording({
        ...target,
        pressed: {
          chord,
          refusal: refusal.kind === "reserved"
            ? { title: "Reserved", reason: refusal.reason }
            : refusal.kind === "needs_modifier"
              ? {
                  title: "Needs a modifier",
                  reason: `A plain key would type into the reply. Add ${mac ? "⌘, ⌃ or ⌥" : "Ctrl or Alt"}. Function keys are the exception.`,
                }
              : { title: "Not a shortcut", reason: "That key cannot be a shortcut." },
        },
      });
      return;
    }
    if (chordsOf(target.actionId).some((existing) => sameChord(existing, chord))) {
      // Already this action's chord: nothing to change.
      setRecording(undefined);
      return;
    }
    const clashWith = findActionUsingChord(bindings, chord, platform, target.actionId);
    if (clashWith !== null) {
      setRecording({ ...target, pressed: { chord, clashWith } });
      return;
    }
    void commitChord(target, chord);
  };

  const query = filter.trim().toLowerCase();
  const actionMatches = (action: KeybindingActionDefinition) => {
    if (show === "changed" && !isActionChanged(action, overrides, platform)) return false;
    if (query === "") return true;
    return action.label.toLowerCase().includes(query)
      || chordsOf(action.id).some((chord) => label(chord).toLowerCase().includes(query));
  };
  const fixedRows = FIXED_KEYBINDINGS.filter((row) =>
    show === "all"
    && (query === ""
      || row.label.toLowerCase().includes(query)
      || row.chords.some((chord) => label(chord).toLowerCase().includes(query))));
  const changedCount = KEYBINDING_ACTIONS.filter((action) =>
    isActionChanged(action, overrides, platform)).length;
  const groups = KEYBINDING_GROUPS.map((group) => ({
    ...group,
    all: KEYBINDING_ACTIONS.filter((action) => action.group === group.id),
    shown: KEYBINDING_ACTIONS.filter((action) => action.group === group.id && actionMatches(action)),
  }));
  const nothingShown = groups.every((group) => group.shown.length === 0) && fixedRows.length === 0;

  return (
    <SettingsSectionStack paneId="keyboard" aria-label="Keyboard shortcuts">
      <SettingsPanelHead
        eyebrow="Keyboard"
        title="Shortcuts"
        help="Shortcuts apply to every profile on this machine. Thread shortcuts act on the selected sidebar rows, or on the open thread when no row has focus."
      />

      {snapshot?.error ? (
        <p className="settings-inline-notice settings-keyboard__notice" role="alert">
          <span
            aria-hidden="true"
            className="status-dot status-dot--warning settings-inline-notice__dot"
          />
          <span>
            keybindings.toml could not be read, so every shortcut has its default
            until the file is fixed. {snapshot.error}
          </span>
        </p>
      ) : null}

      <div className="settings-archive-toolbar settings-keyboard__toolbar">
        <div className="settings-archive-filter" role="search" aria-label="Shortcut search">
          <SearchIcon aria-hidden className="settings-archive-filter__icon" size={13} />
          <input
            className="settings-input settings-archive-filter__input"
            aria-label="Filter shortcuts"
            placeholder="Filter by action or key"
            spellCheck={false}
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter !== "") {
                event.preventDefault();
                setFilter("");
              }
            }}
          />
        </div>
        <SegmentedControl
          label="Show shortcuts"
          options={SHOW_OPTIONS}
          value={show}
          onChange={setShow}
        />
        <button
          className="button button--secondary"
          disabled={changedCount === 0}
          type="button"
          onClick={() => {
            setResetAllError(undefined);
            setRecording(undefined);
            setRowNotes({});
            void writeKeybindings({ kind: "reset_all" }).catch((error: unknown) => {
              setResetAllError(error instanceof Error ? error.message : String(error));
            });
          }}
        >
          Reset All
        </button>
      </div>
      {resetAllError ? (
        <p className="settings-row__error settings-keyboard__error" role="alert">{resetAllError}</p>
      ) : null}

      {groups.map((group) =>
        group.shown.length === 0 ? null : (
          <SettingsSection
            key={group.id}
            title={group.label}
            sectionId={`keyboard-${group.id}`}
            chip={countLabel(group.all, overrides, platform)}
            className="settings-keyboard__section"
          >
            <ul className="settings-keyboard__rows">
              {group.shown.map((action) => (
                <KeybindingRow
                  key={action.id}
                  action={action}
                  chords={chordsOf(action.id)}
                  changed={isActionChanged(action, overrides, platform)}
                  defaultsLabel={defaultChordsFor(action, platform).map(label).join(", ")}
                  error={rowErrors[action.id]}
                  label={label}
                  note={rowNotes[action.id]}
                  recording={recording?.actionId === action.id ? recording : undefined}
                  onAdd={() => setRecording({ actionId: action.id, mode: "add" })}
                  onCancel={() => setRecording(undefined)}
                  onChange={() => setRecording({ actionId: action.id, mode: "replace" })}
                  onMoveHere={(target, chord, from) => void commitChord(target, chord, from)}
                  onRecordKey={recordKey}
                  onRemove={(chord) => {
                    void save(action.id, {
                      kind: "set",
                      actionId: action.id,
                      chords: chordsOf(action.id).filter((existing) => existing !== chord),
                    });
                  }}
                  onReset={() => {
                    setRowNotes((current) => ({ ...current, [action.id]: undefined }));
                    void save(action.id, { kind: "reset", actionId: action.id });
                  }}
                />
              ))}
            </ul>
          </SettingsSection>
        ))}

      {fixedRows.length > 0 ? (
        <SettingsSection
          title="App"
          sectionId="keyboard-app"
          chip={`${FIXED_KEYBINDINGS.length} fixed`}
          className="settings-keyboard__section"
        >
          <p className="settings-row__description">
            Standard on every platform, so they cannot be changed. They are listed
            so a new shortcut does not take one.
          </p>
          <ul className="settings-keyboard__rows">
            {fixedRows.map((row) => (
              <li key={row.label} className="settings-keyboard__row is-fixed">
                <span className="settings-keyboard__label">
                  <span className="settings-keyboard__name">{row.label}</span>
                </span>
                <span className="settings-keyboard__keys">
                  {row.chords.map((chord) => (
                    <kbd key={chord} className="settings-keyboard__cap is-muted">{label(chord)}</kbd>
                  ))}
                </span>
                <span className="settings-keyboard__actions" />
              </li>
            ))}
          </ul>
        </SettingsSection>
      ) : null}

      {nothingShown ? (
        <p className="settings-row__description">
          {show === "changed" && query === ""
            ? "Every shortcut has its default."
            : "No shortcut matches the filter."}
        </p>
      ) : null}

      {snapshot ? (
        <div className="settings-keyboard__file">
          <SettingsCopyValue
            compact
            desktopApi={props.desktopApi}
            label="Saved in"
            value={snapshot.filePath}
          />
        </div>
      ) : null}
    </SettingsSectionStack>
  );
}

function countLabel(
  actions: readonly KeybindingActionDefinition[],
  overrides: Readonly<Record<string, readonly string[]>>,
  platform: string | undefined,
): string {
  const changed = actions.filter((action) => isActionChanged(action, overrides, platform)).length;
  const total = `${actions.length} ${actions.length === 1 ? "action" : "actions"}`;
  return changed === 0 ? total : `${total} · ${changed} changed`;
}

function KeybindingRow(props: {
  action: KeybindingActionDefinition;
  chords: readonly string[];
  changed: boolean;
  defaultsLabel: string;
  error?: string;
  label: (chord: string) => string;
  note?: string;
  recording?: Recording;
  onAdd: () => void;
  onCancel: () => void;
  onChange: () => void;
  onMoveHere: (target: Recording, chord: string, from: KeybindingActionId) => void;
  onRecordKey: (event: KeyboardEvent<HTMLElement>, target: Recording) => void;
  onRemove: (chord: string) => void;
  onReset: () => void;
}) {
  const { action, recording } = props;
  const rowRef = useRef<HTMLLIElement>(null);
  const recorderRef = useRef<HTMLSpanElement>(null);
  const recordingActive = recording !== undefined;
  const pressed = recording?.pressed;
  const clashAction = pressed?.clashWith === undefined
    ? undefined
    : getKeybindingAction(pressed.clashWith);

  useLayoutEffect(() => {
    if (recordingActive) recorderRef.current?.focus();
  }, [recordingActive]);

  return (
    <li ref={rowRef} className={`settings-keyboard__row${recordingActive ? " is-recording" : ""}`}>
      <span className="settings-keyboard__label">
        <span className="settings-keyboard__name">
          {action.label}
          {props.changed ? (
            <span
              className="settings-keyboard__changed"
              role="img"
              aria-label="Changed"
              title={props.defaultsLabel === "" ? "Default: not set" : `Default: ${props.defaultsLabel}`}
            />
          ) : null}
        </span>
        {action.scopeLabel ? (
          <span className="settings-keyboard__scope">{action.scopeLabel}</span>
        ) : null}
      </span>

      <span className="settings-keyboard__keys">
        {recording ? (
          <span
            ref={recorderRef}
            aria-label={`Record a shortcut for ${action.label}`}
            className="settings-keyboard__recorder"
            role="textbox"
            tabIndex={0}
            onBlur={(event) => {
              // Leaving the row cancels; moving to its own Cancel or Move It
              // Here does not.
              if (!rowRef.current?.contains(event.relatedTarget as Node | null)) {
                props.onCancel();
              }
            }}
            onKeyDown={(event) => props.onRecordKey(event, recording)}
          >
            {pressed ? (
              <kbd className="settings-keyboard__cap">{props.label(pressed.chord)}</kbd>
            ) : (
              <>
                <span className="settings-keyboard__rec-dot" aria-hidden="true" />
                Type a shortcut…
              </>
            )}
          </span>
        ) : props.chords.length === 0 ? (
          <span className="settings-keyboard__unset">Not set</span>
        ) : (
          props.chords.map((chord) => (
            <span key={chord} className="settings-keyboard__chord">
              <kbd className="settings-keyboard__cap">{props.label(chord)}</kbd>
              <button
                aria-label={`Remove ${props.label(chord)} from ${action.label}`}
                className="settings-keyboard__remove"
                type="button"
                onClick={() => props.onRemove(chord)}
              >
                ×
              </button>
            </span>
          ))
        )}
      </span>

      <span className="settings-keyboard__actions">
        {recording ? (
          <button className="button button--ghost" type="button" onClick={props.onCancel}>
            Cancel
          </button>
        ) : (
          <>
            {props.changed ? (
              <button
                aria-label={`Reset ${action.label}`}
                className="button button--ghost"
                type="button"
                onClick={props.onReset}
              >
                Reset
              </button>
            ) : null}
            {props.chords.length === 1 ? (
              <button
                aria-label={`Add a second shortcut for ${action.label}`}
                className="button button--ghost"
                type="button"
                onClick={props.onAdd}
              >
                Add
              </button>
            ) : null}
            <button
              aria-label={`Change ${action.label}`}
              className="button button--secondary"
              type="button"
              onClick={props.onChange}
            >
              {props.chords.length === 0 ? "Set" : "Change"}
            </button>
          </>
        )}
      </span>

      {pressed?.refusal ? (
        <p className="settings-keyboard__notice-row" role="alert">
          <span className="settings-keyboard__tag">{pressed.refusal.title}</span>
          <span>{pressed.refusal.reason}</span>
        </p>
      ) : null}
      {pressed && clashAction && recording ? (
        <p className="settings-keyboard__notice-row" role="alert">
          <span className="settings-keyboard__tag">In use</span>
          <span>
            <b>{props.label(pressed.chord)}</b> runs <b>{clashAction.label}</b>.
          </span>
          <span className="settings-keyboard__notice-actions">
            <button className="button button--ghost" type="button" onClick={props.onCancel}>
              Cancel
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() => props.onMoveHere(recording, pressed.chord, clashAction.id)}
            >
              Move It Here
            </button>
          </span>
        </p>
      ) : null}
      {props.note ? <p className="settings-keyboard__note">{props.note}</p> : null}
      {props.error ? (
        <p className="settings-row__error settings-keyboard__row-error" role="alert">{props.error}</p>
      ) : null}
    </li>
  );
}
