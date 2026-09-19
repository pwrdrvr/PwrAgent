import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** What a pane holding unsaved edits offers when the operator leaves it. */
export type UnsavedSettingsChanges = {
  /** Names the pane in the prompt, e.g. "Federation". */
  label: string;
  /** Saves every pending edit. Resolves false when any of them failed. */
  save: () => Promise<boolean>;
  discard: () => void;
};

/** Runs `leave` now, or once the operator has saved or discarded. */
export type ConfirmSettingsLeave = (leave: () => void) => void;

type Register = (changes: UnsavedSettingsChanges) => () => void;

const UnsavedSettingsContext = createContext<Register>(() => () => undefined);

/**
 * Declares the edits a pane would lose if it unmounted now; pass undefined
 * while it holds none. Only explicit-save forms need this. Settings that save
 * as they change have nothing to lose.
 */
export function useUnsavedSettingsChanges(
  changes: UnsavedSettingsChanges | undefined,
): void {
  const register = useContext(UnsavedSettingsContext);
  // Every render: the save and discard closures read that render's values.
  useEffect(() => (changes ? register(changes) : undefined));
}

/**
 * The Settings screen's half: collects the mounted pane's unsaved edits and
 * asks Save / Discard / Keep editing before a route that would unmount it.
 */
export function useUnsavedSettingsGuard(): {
  confirmLeave: ConfirmSettingsLeave;
  provide: (children: ReactNode) => ReactNode;
  dialog: ReactNode;
} {
  const changesRef = useRef<UnsavedSettingsChanges | undefined>(undefined);
  const [pending, setPending] = useState<{
    label: string;
    leave: () => void;
    returnFocus: Element | null;
  }>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const register = useCallback<Register>((changes) => {
    changesRef.current = changes;
    return () => {
      if (changesRef.current === changes) changesRef.current = undefined;
    };
  }, []);

  const confirmLeave = useCallback<ConfirmSettingsLeave>((leave) => {
    const changes = changesRef.current;
    if (!changes) {
      leave();
      return;
    }
    setFailed(false);
    setPending((current) => ({
      label: changes.label,
      leave,
      // A second request while the prompt is open replaces where it goes,
      // not where focus returns to.
      returnFocus: current ? current.returnFocus : document.activeElement,
    }));
  }, []);

  const keepEditing = () => {
    const returnFocus = pending?.returnFocus;
    setPending(undefined);
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
      returnFocus.focus();
    }
  };
  // Forget the edits before leaving: the pane unmounts, and an outer caller
  // (App closing the overlay) asks again on the way out.
  const leaveNow = () => {
    const leave = pending?.leave;
    changesRef.current = undefined;
    setPending(undefined);
    leave?.();
  };
  const discard = () => {
    changesRef.current?.discard();
    leaveNow();
  };
  const save = async () => {
    setSaving(true);
    setFailed(false);
    // The pane re-registers on every render; ask the current one.
    const saved = await (changesRef.current?.save() ?? Promise.resolve(true));
    setSaving(false);
    if (saved) {
      leaveNow();
    } else {
      setFailed(true);
    }
  };

  return {
    confirmLeave,
    provide: (children) => (
      <UnsavedSettingsContext.Provider value={register}>
        {children}
      </UnsavedSettingsContext.Provider>
    ),
    dialog: pending ? (
      <UnsavedSettingsDialog
        failed={failed}
        label={pending.label}
        saving={saving}
        onDiscard={discard}
        onKeepEditing={keepEditing}
        onSave={() => void save()}
      />
    ) : null,
  };
}

function UnsavedSettingsDialog(props: {
  failed: boolean;
  label: string;
  saving: boolean;
  onDiscard: () => void;
  onKeepEditing: () => void;
  onSave: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const { onKeepEditing, saving } = props;
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        onKeepEditing();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeepEditing, saving]);

  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        ref={dialogRef}
        aria-describedby="unsaved-settings-description"
        aria-labelledby="unsaved-settings-heading"
        aria-modal="true"
        className="settings-confirm-dialog settings-unsaved-dialog"
        role="alertdialog"
        tabIndex={-1}
      >
        <h2 id="unsaved-settings-heading">Save changes to {props.label}?</h2>
        <p id="unsaved-settings-description">
          {props.failed
            ? "The changes were not saved. Keep editing to see what needs fixing, or discard them."
            : `Your ${props.label} settings have edits that are not saved. Leaving without saving discards them.`}
        </p>
        <div className="settings-confirm-dialog__actions">
          <button
            className="button button--secondary"
            disabled={props.saving}
            type="button"
            onClick={props.onKeepEditing}
          >
            Keep editing
          </button>
          <button
            className="button button--ghost"
            disabled={props.saving}
            type="button"
            onClick={props.onDiscard}
          >
            Discard changes
          </button>
          <button
            className="button button--primary"
            disabled={props.saving}
            type="button"
            onClick={props.onSave}
          >
            {props.saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
