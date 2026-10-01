import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ReceivingFolderRequest, ReceivingFolderResponse } from "../../../../shared/federation-receiving-folder";

export function IncomingFilesFolderActions(props: {
  desktopApi?: DesktopApi;
  directory: string;
  savedDirectory: string;
  enabled: boolean;
  disabled: boolean;
  onChoose: (directory: string) => Promise<void>;
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
  const disabled = props.disabled || busy || !api;
  return (
    <div data-receiving-folder-actions>
      <div className="incoming-files-folder-actions">
        <button type="button" className="button button--secondary" disabled={disabled} onClick={() => void action("browse")}>Browse…</button>
        <button type="button" className="button button--secondary" disabled={disabled} onClick={() => void action("reveal")}>Reveal folder</button>
        <button type="button" className="button button--secondary" disabled={disabled} onClick={() => void action("check")}>Check access</button>
        {result?.response.privacySettingsSupported ? (
          <button type="button" className="button button--secondary" disabled={disabled} onClick={() => void action("privacy")}>Open Files & Folders</button>
        ) : null}
      </div>
      <div className="settings-field__help" role="status" aria-live="polite">
        {current ? <div>Receiving folder: {current.directory}</div> : null}
        <div>{current?.access?.message ?? "Folder access has not been checked. Use Check access to test writing a temporary file."}</div>
        {result?.response.privacySettingsSupported ? (
          <div>macOS privacy permission: unknown. Review PwrAgent in System Settings → Privacy &amp; Security → Files &amp; Folders. Browse lets you select the folder directly; macOS may ask for access.</div>
        ) : null}
      </div>
      {error ? <p role="alert" className="settings-row__error">{error}</p> : null}
    </div>
  );
}
