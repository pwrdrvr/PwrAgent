import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ReceivingFolderRequest, ReceivingFolderResponse } from "../../../../shared/federation-receiving-folder";

export function IncomingFilesFolderActions(props: {
  desktopApi?: DesktopApi;
  directory: string;
  savedDirectory: string;
  enabled: boolean;
  disabled: boolean;
  onChoose: (directory: string) => Promise<void>;
  /** The folder input. Browse fills it, so the two share a row. */
  children: ReactNode;
}) {
  const api = props.desktopApi?.receivingFolder;
  const [result, setResult] = useState<{ configured: string; response: ReceivingFolderResponse }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);

  useEffect(() => {
    const id = ++sequence.current;
    setError(undefined);
    if (!api) return;
    let active = true;
    void api({ action: props.enabled ? "check" : "inspect", directory: props.savedDirectory }).then((response) => {
      if (active && sequence.current === id) setResult({ configured: props.savedDirectory, response });
    }).catch((caught) => {
      if (active && sequence.current === id) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { active = false; };
  }, [api, props.enabled, props.savedDirectory]);

  const action = async (kind: ReceivingFolderRequest["action"]) => {
    if (!api || busy) return;
    const id = ++sequence.current;
    const configured = props.directory;
    setBusy(true);
    setError(undefined);
    try {
      // Browse and the privacy shortcut remain usable during an invalid draft.
      const response = await api({ action: kind, directory: kind === "privacy" || kind === "browse" ? props.savedDirectory : configured });
      if (sequence.current !== id) return;
      if (kind !== "privacy") {
        setResult((previous) => ({
          configured: kind === "browse" ? props.savedDirectory : configured,
          response: {
            ...response,
            access: kind === "check" ? response.access : previous?.configured === configured ? previous.response.access : undefined,
          },
        }));
      }
      if (kind === "browse") {
        if (!response.canceled) await props.onChoose(response.directory);
      }
    } catch (caught) {
      if (sequence.current === id) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const current = result?.configured === props.directory ? result.response : undefined;
  const access = current?.access;
  // Native disabling drops browser focus without the blur that saves a draft.
  // Keep pending actions focusable; action() ignores repeat activations.
  const disabled = props.disabled || !api;
  const actionButton = (kind: ReceivingFolderRequest["action"], label: string, title?: string) => (
    <button
      type="button"
      className="button button--ghost incoming-files-folder__action"
      disabled={disabled}
      aria-disabled={busy || disabled}
      title={title}
      onClick={() => void action(kind)}
    >
      {label}
    </button>
  );
  return (
    <div className="incoming-files-folder" data-receiving-folder-actions>
      <div className="incoming-files-folder__row">
        {props.children}
        <button
          type="button"
          className="button button--secondary incoming-files-folder__browse"
          disabled={disabled}
          aria-disabled={busy || disabled}
          onClick={() => void action("browse")}
        >
          Browse…
        </button>
      </div>
      {/* Only a blank field hides where files land; a typed path already says it. */}
      {current && !props.directory.trim() ? (
        <p className="incoming-files-folder__path">Saves to {current.directory}</p>
      ) : null}
      <div className="incoming-files-folder__line">
        <div className="incoming-files-folder__status" role="status" aria-live="polite">
          <span className="incoming-files-folder__result">
            <span className={`settings-pathrow__chip${access?.status === "writable" ? " settings-pathrow__chip--ok" : access?.status === "failed" ? " settings-pathrow__chip--err" : ""}`}>
              {access?.status === "writable" ? "Writable" : access?.status === "failed" ? "Not writable" : "Not checked"}
            </span>
            {access?.status === "writable" ? <span className="incoming-files-folder__note">{access.message}</span> : null}
          </span>
          {access?.status === "failed" ? <span className="incoming-files-folder__failure">{access.message}</span> : null}
        </div>
        <span className="incoming-files-folder__actions">
          {actionButton("check", "Check access", "Write and remove a test file in this folder")}
          {actionButton("reveal", "Open folder")}
        </span>
      </div>
      {result?.response.privacySettingsSupported ? (
        <div className="incoming-files-folder__line">
          <span className="incoming-files-folder__note">macOS privacy settings can still block this folder.</span>
          <span className="incoming-files-folder__actions">
            {actionButton("privacy", "Open Files & Folders")}
          </span>
        </div>
      ) : null}
      {error ? <p role="alert" className="settings-row__error">{error}</p> : null}
    </div>
  );
}
