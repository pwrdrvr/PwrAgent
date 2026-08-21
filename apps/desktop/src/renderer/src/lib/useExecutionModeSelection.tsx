import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { ThreadExecutionMode } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import {
  invalidateDesktopSettingsRead,
  readDesktopSettingsCoalesced,
  rememberDesktopSettingsSnapshot,
} from "./settings-read-coordinator";

/**
 * The renderer's single gate on escalating a thread to Full Access.
 *
 * Every surface that can raise a thread's execution mode routes its
 * selection through here instead of calling `setThreadExecutionMode`
 * directly, so the "Enable Full Access?" confirmation cannot be bypassed
 * by adding a new menu. The gate used to live inside `Composer`, which
 * meant the Star Map chat card's settings chip escalated a thread in one
 * un-gated click.
 *
 * Messaging surfaces (Telegram/Discord `togglePermissionsMode`) do NOT
 * share this gate, and that is deliberate: an escalation requested from
 * chat is made by a remote actor, so `MessagingController` gates it on
 * the `thread.execution.full_access` RBAC permission, the operator's
 * `warningPolicy`, and a per-contact `fullAccessWarningDismissed` flag.
 * This desktop-local "do not warn me again on this desktop" preference is
 * the operator's own acknowledgement and must never dismiss the warning
 * shown to a messaging contact.
 */

/**
 * Window-wide view of the dismissed-forever preference.
 *
 * Shared rather than per-hook so a dismissal accepted in one card is
 * honored by every other surface in the same window without a re-read,
 * and so N mounted cards issue one settings read between them.
 */
let dismissedCache: boolean | undefined;
let dismissedRead: Promise<void> | undefined;
let dismissedReadToken = 0;
const dismissedListeners = new Set<(dismissed: boolean) => void>();

function publishDismissed(dismissed: boolean): void {
  dismissedCache = dismissed;
  for (const listener of dismissedListeners) {
    listener(dismissed);
  }
}

/** Test seam: module state outlives a render tree. */
export function resetFullAccessRiskWarningCache(): void {
  dismissedCache = undefined;
  dismissedRead = undefined;
}

function loadDismissed(desktopApi: DesktopApi): Promise<void> {
  if (dismissedRead) {
    return dismissedRead;
  }
  const token = ++dismissedReadToken;
  dismissedRead = (async () => {
    try {
      const response = await readDesktopSettingsCoalesced(desktopApi);
      publishDismissed(
        response.snapshot.experimental.fullAccessRiskWarningDismissed?.value
          === true,
      );
    } catch {
      // Unreadable settings leave the warning on: the gate fails closed,
      // and the next request retries the read.
      if (dismissedReadToken === token) {
        dismissedRead = undefined;
      }
    }
  })();
  return dismissedRead;
}

async function persistDismissed(desktopApi: DesktopApi): Promise<void> {
  if (!desktopApi.writeSettingsConfig) {
    throw new Error("Could not save the Full Access warning preference.");
  }
  invalidateDesktopSettingsRead(desktopApi);
  const response = await desktopApi.writeSettingsConfig({
    patch: { experimental: { fullAccessRiskWarningDismissed: true } },
  });
  rememberDesktopSettingsSnapshot(desktopApi, response);
  publishDismissed(true);
}

export type ExecutionModeSelectionOptions = {
  /**
   * Applies the mode once the gate is satisfied. Called synchronously for
   * a de-escalation or an already-acknowledged escalation, and from the
   * dialog's accept button otherwise.
   */
  applyExecutionMode: (executionMode: ThreadExecutionMode) => void;
  /** The target's current mode — a thread's, or a launchpad draft's. */
  currentExecutionMode?: ThreadExecutionMode;
  desktopApi?: DesktopApi;
  /**
   * Overrides the settings-backed preference for a surface that already
   * holds a live snapshot (the main window's `App` owns one and keeps it
   * current). Leave it undefined and the hook reads the preference
   * itself, which is what a surface with no settings state — the Star Map
   * chat card — relies on.
   */
  dismissed?: boolean;
  /** Paired override for the write half of `dismissed`. */
  onDismiss?: () => Promise<void>;
};

export type ExecutionModeSelection = {
  /**
   * Mount this where the surface renders. It portals to `document.body`,
   * so its position in the tree does not matter.
   */
  fullAccessRiskDialog: ReactNode;
  /**
   * Stable across renders so a memoized menu that closes over it does not
   * churn; the latest options are read through a ref.
   */
  requestExecutionModeSelection: (executionMode: ThreadExecutionMode) => void;
};

export function useExecutionModeSelection(
  options: ExecutionModeSelectionOptions,
): ExecutionModeSelection {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dontWarnAgain, setDontWarnAgain] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [readDismissed, setReadDismissed] = useState(dismissedCache ?? false);

  const ownsPreference = options.dismissed === undefined;
  const desktopApi = options.desktopApi;

  useEffect(() => {
    if (!ownsPreference || !desktopApi?.readSettings) {
      return;
    }
    let active = true;
    const listener = (dismissed: boolean): void => {
      if (active) {
        setReadDismissed(dismissed);
      }
    };
    dismissedListeners.add(listener);
    if (dismissedCache !== undefined) {
      setReadDismissed(dismissedCache);
    }
    void loadDismissed(desktopApi);
    return () => {
      active = false;
      dismissedListeners.delete(listener);
    };
  }, [desktopApi, ownsPreference]);

  const dismissed = options.dismissed ?? readDismissed;
  const dismissedRef = useRef(dismissed);
  dismissedRef.current = dismissed;

  const requestExecutionModeSelection = useCallback(
    (executionMode: ThreadExecutionMode): void => {
      const current = optionsRef.current;
      if (
        executionMode === "full-access"
        && current.currentExecutionMode !== "full-access"
        && !dismissedRef.current
      ) {
        setDontWarnAgain(false);
        setError(undefined);
        setDialogOpen(true);
        return;
      }

      current.applyExecutionMode(executionMode);
    },
    [],
  );

  const confirm = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      if (dontWarnAgain) {
        const current = optionsRef.current;
        if (current.onDismiss) {
          await current.onDismiss();
        } else if (current.desktopApi) {
          await persistDismissed(current.desktopApi);
        }
      }
      setDialogOpen(false);
      optionsRef.current.applyExecutionMode("full-access");
    } catch (confirmError) {
      setError(
        confirmError instanceof Error
          ? confirmError.message
          : String(confirmError),
      );
    } finally {
      setSaving(false);
    }
  }, [dontWarnAgain]);

  const fullAccessRiskDialog = dialogOpen
    ? createPortal(
        <div className="full-access-warning-modal">
          <div
            aria-labelledby="full-access-warning-title"
            aria-modal="true"
            className="full-access-warning-dialog"
            role="dialog"
          >
            <div className="full-access-warning-dialog__header">
              <h2 id="full-access-warning-title">Enable Full Access?</h2>
              <button
                aria-label="Cancel Full Access warning"
                className="workspace-handoff-dialog__close"
                disabled={saving}
                type="button"
                onClick={() => {
                  setDialogOpen(false);
                }}
              >
                ×
              </button>
            </div>
            <p>
              Full Access allows network access and read/write access to almost
              all files on this machine.
            </p>
            <p>
              That means data can be exfiltrated unintentionally, or by
              malicious code the agent downloads and executes through a supply
              chain attack on npm, PyPI, Rust crates, Go modules, or a similar
              dependency source.
            </p>
            <label className="composer__checkbox full-access-warning-dialog__checkbox">
              <input
                checked={dontWarnAgain}
                disabled={saving}
                type="checkbox"
                onChange={(event) =>
                  setDontWarnAgain(event.currentTarget.checked)
                }
              />
              <span>Do not warn me again on this desktop.</span>
            </label>
            {error ? (
              <p className="full-access-warning-dialog__error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="full-access-warning-dialog__actions">
              <button
                className="button button--secondary"
                disabled={saving}
                type="button"
                onClick={() => {
                  setDialogOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                disabled={saving}
                type="button"
                onClick={() => {
                  void confirm();
                }}
              >
                I Understand and Accept the Risks
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return { fullAccessRiskDialog, requestExecutionModeSelection };
}
