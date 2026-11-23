import { useId, useState } from "react";
import { createPortal } from "react-dom";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useModalDialog } from "../../../lib/useModalDialog";

export function SaveAgentPresetButton(props: { thread: NavigationThreadSummary; desktopApi: DesktopApi }) {
  const [open, setOpen] = useState(false);
  if (!props.thread.agent || !props.desktopApi.manageAgentPresets || !props.desktopApi.readThreadMcpConnections) return null;
  return (
    <>
      <button className="context-list__action agent-preset-save" type="button" onClick={() => setOpen(true)}>Save as preset…</button>
      {open ? <SaveAgentPresetDialog thread={props.thread} desktopApi={props.desktopApi} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SaveAgentPresetDialog(props: { thread: NavigationThreadSummary; desktopApi: DesktopApi; onClose: () => void }) {
  const [name, setName] = useState(props.thread.agent?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const headingId = useId();
  const ref = useModalDialog({ onClose: () => { if (!busy) props.onClose(); } });
  const save = async () => {
    const { thread, desktopApi } = props;
    const { agent } = thread;
    if (!agent || !desktopApi.readThreadMcpConnections || !desktopApi.manageAgentPresets) return;
    setBusy(true);
    setError(undefined);
    try {
      const { connectionIds } = await desktopApi.readThreadMcpConnections({ threadId: thread.id, backend: thread.source });
      await desktopApi.manageAgentPresets({ action: "save", preset: {
        name,
        instructions: agent.instructionsDelivery === "workspace-file" ? undefined : agent.instructions,
        mcpConnectionIds: connectionIds,
      } });
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="settings-confirm-modal" role="presentation">
      <div className="settings-confirm-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}>
        <h2 id={headingId}>Save Agent preset</h2>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="agent-preset-name-field">Name
            <input className="settings-input" disabled={busy} maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          {error ? <p className="settings-row__error" role="alert">{error}</p> : null}
          <div className="settings-confirm-dialog__actions">
            <button className="button button--secondary" disabled={busy} type="button" onClick={props.onClose}>Cancel</button>
            <button className="button button--primary" disabled={busy || !name.trim()} type="submit">Save preset</button>
          </div>
        </form>
      </div>
    </div>, document.body,
  );
}
