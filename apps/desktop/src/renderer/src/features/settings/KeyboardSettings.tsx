import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  FIXED_KEYBINDINGS,
  KEYBINDING_ACTIONS,
  KEYBINDING_GROUPS,
  chordFromEvent,
  chordIdentity,
  defaultChordsFor,
  findActionUsingChord,
  formatChordLabel,
  formatModifiersLabel,
  getKeybindingAction,
  isActionChanged,
  isModifierKey,
  isTextEditingChord,
  parseChord,
  refuseChord,
  type KeybindingActionDefinition,
  type KeybindingActionId,
  type KeybindingWriteRequest,
} from "../../../../shared/keybindings";
import { SearchIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { useKeybindings, writeKeybindings } from "../../lib/keybindings-store";
import { useModalDialog } from "../../lib/useModalDialog";
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
  /**
   * What is held right now: modifiers alone, or a whole chord that saves when
   * its key (or a modifier) is let go.
   */
  live?: { label: string; chord?: string; code: string; key: string };
  saving?: boolean;
  /** The last thing pressed that could not be saved as it stands. */
  pressed?: {
    chord?: string;
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
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const resetAllRef = useRef<HTMLButtonElement>(null);
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
    const failed = () => setRecording((current) =>
      current?.actionId === target.actionId ? { ...current, live: undefined, saving: false } : current);
    // Move It Here takes the chord from the other action in the same save,
    // so the file never holds it twice and a failure leaves both as they were.
    const request: KeybindingWriteRequest = takeFrom === undefined
      ? { kind: "set", actionId: target.actionId, chords: next }
      : {
          kind: "set_many",
          changes: [
            {
              actionId: takeFrom,
              chords: chordsOf(takeFrom).filter((existing) => !sameChord(existing, chord)),
            },
            { actionId: target.actionId, chords: next },
          ],
        };
    if (!(await save(target.actionId, request))) {
      failed();
      return;
    }
    setRecording(undefined);
    const action = getKeybindingAction(target.actionId);
    setRowNotes((current) => ({
      ...current,
      [target.actionId]: action?.firesInTextFields && isTextEditingChord(chord, platform)
        ? `${label(chord)} edits text in a field, so it does nothing while you type.`
        : undefined,
    }));
  };

  /** A recorder that has only this action and mode: nothing held, nothing refused. */
  const fresh = (target: Recording): Recording => ({ actionId: target.actionId, mode: target.mode });

  const refusalFor = (chord: string, key: string): Recording["pressed"] => {
    const refusal = refuseChord(chord, platform);
    if (refusal === null) return undefined;
    if (refusal.kind === "reserved") {
      return { chord, refusal: { title: "Reserved", reason: refusal.reason } };
    }
    if (refusal.kind === "needs_modifier" && (key === "Backspace" || key === "Delete")) {
      return {
        chord,
        refusal: {
          title: "Does not clear",
          reason: `${key} does not clear a shortcut. Use the × beside a shortcut to remove it.`,
        },
      };
    }
    if (refusal.kind === "needs_modifier") {
      return {
        chord,
        refusal: {
          title: "Needs a modifier",
          reason: `A plain key would type into the reply. Add ${mac ? "⌘, ⌃ or ⌥" : "Ctrl or Alt"}. Function keys are the exception.`,
        },
      };
    }
    return { chord, refusal: { title: "Not a shortcut", reason: "That key cannot be a shortcut." } };
  };

  /** The chord was let go: save it, or say why it cannot be saved. */
  const finishChord = (target: Recording, chord: string) => {
    if (chordsOf(target.actionId).some((existing) => sameChord(existing, chord))) {
      // Already this action's chord: nothing to change.
      setRecording(undefined);
      return;
    }
    const clashWith = findActionUsingChord(bindings, chord, platform, target.actionId);
    if (clashWith !== null) {
      setRecording({ ...fresh(target), pressed: { chord, clashWith } });
      return;
    }
    setRecording({ ...fresh(target), live: target.live, saving: true });
    void commitChord(target, chord);
  };

  const recordKeyDown = (event: KeyboardEvent<HTMLElement>, target: Recording) => {
    // Tab and Shift+Tab leave the recorder like any field; the blur cancels.
    // Neither could be saved: Shift alone is not a modifier for a shortcut.
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) return;
    // The recorder swallows every other key, including the chord it would
    // otherwise fire.
    event.preventDefault();
    event.stopPropagation();
    if (target.saving || event.repeat) return;
    if (event.key === "Escape") {
      setRecording(undefined);
      return;
    }
    if (event.nativeEvent.isComposing || event.key === "Process") {
      setRecording({
        ...fresh(target),
        pressed: {
          refusal: {
            title: "Composing",
            reason: "Finish typing in the input method, then press a shortcut.",
          },
        },
      });
      return;
    }
    if (isModifierKey(event.key)) {
      const held = formatModifiersLabel(event, platform);
      setRecording({
        ...fresh(target),
        live: held === "" ? undefined : { label: held, code: event.code, key: event.key },
      });
      return;
    }
    const chord = chordFromEvent(event, platform);
    if (chord === null) {
      setRecording({
        ...fresh(target),
        pressed: { refusal: { title: "Not a shortcut", reason: "That key cannot be a shortcut." } },
      });
      return;
    }
    const refused = refusalFor(chord, parseChord(chord)?.key ?? "");
    if (refused !== undefined) {
      setRecording({ ...fresh(target), pressed: refused });
      return;
    }
    setRecording({
      ...fresh(target),
      live: { label: label(chord), chord, code: event.code, key: event.key },
    });
  };

  const recordKeyUp = (event: KeyboardEvent<HTMLElement>, target: Recording) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (target.saving) return;
    const live = target.live;
    if (live?.chord !== undefined) {
      const sameKey = live.code !== "" && event.code !== ""
        ? live.code === event.code
        : live.key === event.key;
      // A modifier counts too: macOS can drop the key's own keyup while ⌘ is
      // held, and letting go of ⌘ still ends the chord.
      if (sameKey || isModifierKey(event.key)) finishChord(target, live.chord);
      return;
    }
    if (isModifierKey(event.key)) {
      const held = formatModifiersLabel(event, platform);
      setRecording({
        ...fresh(target),
        live: held === "" ? undefined : { label: held, code: event.code, key: event.key },
      });
    }
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
          ref={resetAllRef}
          className="button button--secondary"
          disabled={changedCount === 0}
          type="button"
          onClick={() => {
            setResetAllError(undefined);
            setRecording(undefined);
            setConfirmingReset(true);
          }}
        >
          Reset All
        </button>
      </div>
      {confirmingReset ? (
        <ResetAllDialog
          busy={resetting}
          changes={KEYBINDING_ACTIONS
            .filter((action) => isActionChanged(action, overrides, platform))
            .map((action) => ({
              id: action.id,
              label: action.label,
              current: chordsOf(action.id).map(label),
              defaults: defaultChordsFor(action, platform).map(label),
            }))}
          error={resetAllError}
          returnFocus={resetAllRef}
          onCancel={() => setConfirmingReset(false)}
          onConfirm={() => {
            setResetAllError(undefined);
            setResetting(true);
            writeKeybindings({ kind: "reset_all" })
              .then(() => {
                setRowNotes({});
                setConfirmingReset(false);
              })
              .catch((error: unknown) => {
                const detail = error instanceof Error ? error.message : String(error);
                setResetAllError(`${detail} Your shortcuts were not changed.`);
              })
              .finally(() => setResetting(false));
          }}
        />
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
                  platform={platform}
                  recording={recording?.actionId === action.id ? recording : undefined}
                  onAdd={() => setRecording({ actionId: action.id, mode: "add" })}
                  onCancel={() => setRecording(undefined)}
                  onChange={() => setRecording({ actionId: action.id, mode: "replace" })}
                  onMoveHere={(target, chord, from) => void commitChord(target, chord, from)}
                  onRecordKeyDown={recordKeyDown}
                  onRecordKeyUp={recordKeyUp}
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
  onRecordKeyDown: (event: KeyboardEvent<HTMLElement>, target: Recording) => void;
  onRecordKeyUp: (event: KeyboardEvent<HTMLElement>, target: Recording) => void;
  platform: string | undefined;
  onRemove: (chord: string) => void;
  onReset: () => void;
}) {
  const { action, recording } = props;
  const hintId = useId();
  const rowRef = useRef<HTMLLIElement>(null);
  const recorderRef = useRef<HTMLSpanElement>(null);
  const recordingActive = recording !== undefined;
  const pressed = recording?.pressed;
  const clashAction = pressed?.clashWith === undefined
    ? undefined
    : getKeybindingAction(pressed.clashWith);
  // A refusal or a clash takes the hint's place under the row.
  const showHint = recording !== undefined && !pressed?.refusal && !clashAction;

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
            aria-describedby={showHint ? hintId : undefined}
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
            onKeyDown={(event) => props.onRecordKeyDown(event, recording)}
            onKeyUp={(event) => props.onRecordKeyUp(event, recording)}
          >
            <span className="settings-keyboard__rec-dot" aria-hidden="true" />
            {recording.live ? (
              <kbd
                className={`settings-keyboard__cap${recording.live.chord === undefined ? " is-partial" : ""}`}
              >
                {recording.live.label}
              </kbd>
            ) : pressed?.chord !== undefined ? (
              <kbd className="settings-keyboard__cap">{props.label(pressed.chord)}</kbd>
            ) : (
              <ExampleChord platform={props.platform} />
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
      {pressed?.chord !== undefined && clashAction && recording ? (
        <p className="settings-keyboard__notice-row" role="alert">
          <span className="settings-keyboard__tag">In use</span>
          <span>
            <b>{props.label(pressed.chord)}</b> runs <b>{clashAction.label}</b>.
          </span>
          {/* The row's own Cancel (and Escape) already back out. */}
          <span className="settings-keyboard__notice-actions">
            <button
              className="button button--primary"
              type="button"
              onClick={() => props.onMoveHere(recording, pressed.chord!, clashAction.id)}
            >
              Move It Here
            </button>
          </span>
        </p>
      ) : null}
      {showHint && recording ? (
        <p id={hintId} className="settings-keyboard__hint" aria-live="polite">
          {recordingHint(recording)}
        </p>
      ) : null}
      {props.note ? <p className="settings-keyboard__note">{props.note}</p> : null}
      {props.error ? (
        <p className="settings-row__error settings-keyboard__row-error" role="alert">{props.error}</p>
      ) : null}
    </li>
  );
}

/** What to do next, for the line under a recording row. */
function recordingHint(recording: Recording): string {
  if (recording.saving) return "Saving…";
  if (recording.live?.chord !== undefined) return `Let go to save ${recording.live.label}.`;
  if (recording.live) return "Keep holding, and press another key.";
  return "Press the keys together, then let go. Escape cancels.";
}

/** The idle recorder's example: a chord whose keys light in turn. */
function ExampleChord(props: { platform: string | undefined }) {
  const parts = props.platform === "darwin" ? ["⇧", "⌘", "K"] : ["Ctrl", "+", "Shift", "+", "K"];
  return (
    <kbd aria-hidden="true" className="settings-keyboard__cap is-example">
      {parts.map((part, index) => <span key={index}>{part}</span>)}
    </kbd>
  );
}

/** Reset All, confirmed: every changed action, what it is now and what it goes back to. */
function ResetAllDialog(props: {
  busy: boolean;
  changes: Array<{ id: string; label: string; current: string[]; defaults: string[] }>;
  error?: string;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const count = props.changes.length;
  const noun = count === 1 ? "shortcut" : "shortcuts";
  const dialogRef = useModalDialog({
    onClose: () => {
      if (!props.busy) props.onCancel();
    },
    returnFocus: props.returnFocus,
  });
  const keys = (labels: string[]) => labels.length === 0
    ? <span className="settings-keyboard__unset">Not set</span>
    : labels.map((text) => <kbd key={text} className="settings-keyboard__cap">{text}</kbd>);
  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        ref={dialogRef}
        aria-labelledby="keyboard-reset-heading"
        aria-modal="true"
        className="settings-confirm-dialog"
        role="dialog"
      >
        <h2 id="keyboard-reset-heading">Reset {count} {noun} to {count === 1 ? "its default" : "their defaults"}?</h2>
        <p>Every profile on this machine picks up the change. You can set any of them again here.</p>
        <ul className="settings-keyboard__reset-list" aria-label="Shortcuts to reset">
          {props.changes.map((change) => (
            <li key={change.id} className="settings-keyboard__reset-item">
              <span>{change.label}</span>
              <span className="settings-keyboard__reset-keys">{keys(change.current)}</span>
              <span className="settings-keyboard__reset-arrow" aria-label="becomes">→</span>
              <span className="settings-keyboard__reset-keys">{keys(change.defaults)}</span>
            </li>
          ))}
        </ul>
        {props.error ? <p className="settings-row__error" role="alert">{props.error}</p> : null}
        <div className="settings-confirm-dialog__actions">
          <button
            className="button button--secondary"
            disabled={props.busy}
            type="button"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            className="button button--primary"
            disabled={props.busy}
            type="button"
            onClick={props.onConfirm}
          >
            {props.busy ? "Resetting…" : `Reset ${count} ${count === 1 ? "Shortcut" : "Shortcuts"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
