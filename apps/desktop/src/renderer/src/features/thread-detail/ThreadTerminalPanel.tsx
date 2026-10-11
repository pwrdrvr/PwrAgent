import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { IntegratedTerminal } from "./IntegratedTerminal";
import type { DesktopApi } from "../../lib/desktop-api";
import type { IntegratedTerminalPane, IntegratedTerminalsController } from "../../lib/useIntegratedTerminals";

export function ThreadTerminalPanel({ desktopApi, terminals, threadKey, panes, visible }: {
  desktopApi?: DesktopApi;
  terminals: IntegratedTerminalsController;
  threadKey: string;
  panes: IntegratedTerminalPane[];
  visible: boolean;
}) {
  const height = terminals.heightByThread[threadKey] ?? 260;
  const selected = panes.find((pane) => pane.sessionId === terminals.selectedByThread[threadKey]) ?? panes[0];
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const changeHeight = (value: number) => terminals.setHeight(threadKey, Math.max(140, Math.min(560, value)));
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = event.clientY;
    const target = event.currentTarget;
    const move = (next: globalThis.PointerEvent) => changeHeight(height + start - next.clientY);
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("lostpointercapture", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("lostpointercapture", end, { once: true });
  };
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowDown" ? (index + 1) % panes.length
      : event.key === "ArrowUp" ? (index + panes.length - 1) % panes.length
      : event.key === "Home" ? 0 : event.key === "End" ? panes.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    const pane = panes[next]!;
    terminals.selectTerminal(threadKey, pane.sessionId);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const saveName = () => {
    if (editing) terminals.renameTerminal(editing, name);
    setEditing(undefined);
  };
  return (
    <section className="thread-terminal-panel" aria-label="Thread terminals" hidden={!visible}
      style={{ "--integrated-terminal-height": `${height}px` } as CSSProperties}>
      <div className="integrated-terminal__resize-handle" role="separator" tabIndex={0}
        aria-label="Resize terminal" aria-orientation="horizontal" aria-valuemin={140} aria-valuemax={560} aria-valuenow={height}
        onPointerDown={resize} onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault(); changeHeight(height + (event.key === "ArrowUp" ? 16 : -16));
          }
        }} />
      <div className="thread-terminal-panel__body">
        <div className="thread-terminal-panel__screens">
          {panes.map((pane) => (
            <div key={pane.sessionId} role="tabpanel" id={`terminal-panel-${pane.sessionId}`}
              aria-labelledby={`terminal-tab-${pane.sessionId}`} hidden={pane !== selected}>
              {pane.status === "restored" || pane.status === "exited" ? <div className="thread-terminal-panel__history-note">
                {pane.status === "restored" ? "Saved output · the previous process ended." : "Shell exited."} Create a new terminal to start a shell.
              </div> : null}
              <IntegratedTerminal desktopApi={desktopApi} threadKey={threadKey} sessionId={pane.sessionId}
                attachOnly={!pane.pending} newSession={pane.newSession} cwd={pane.cwd} remote={pane.remote} height={height} chrome="hosted"
                visible={visible && pane === selected} onClose={() => terminals.closeTerminal(pane)}
                onExit={() => terminals.handleExit(threadKey)} />
            </div>
          ))}
        </div>
        <aside className="thread-terminal-panel__sidebar" aria-label="Terminal sessions">
          <div className="thread-terminal-panel__actions">
            <span>TERMINALS</span>
            <button type="button" aria-label="New terminal" title="New terminal"
              onClick={() => terminals.createTerminal(threadKey, selected?.cwd, selected?.remote)}>+</button>
            <button type="button" aria-label="Hide terminals" title="Hide terminals"
              onClick={() => terminals.togglePanel(threadKey, selected?.cwd, selected?.remote)}>−</button>
          </div>
          <div className="thread-terminal-panel__list">
          <div ref={listRef} role="tablist" aria-label="Terminals" aria-orientation="vertical">
            {panes.map((pane, index) => {
              const label = pane.name || (pane.shell ? `${pane.shell.split(/[/\\]/).pop()} ${index + 1}` : `Terminal ${index + 1}`);
              const status = pane.pending ? "Starting" : pane.status === "restored" ? "Saved" : pane.status === "exited" ? "Exited" : "Running";
              return <button className="thread-terminal-panel__row" key={pane.sessionId} type="button" role="tab" id={`terminal-tab-${pane.sessionId}`}
                  aria-controls={`terminal-panel-${pane.sessionId}`} aria-selected={pane === selected}
                  tabIndex={pane === selected ? 0 : -1} title={`${label} · ${status}\n${pane.remote?.instanceLabel ?? "This machine"}\n${pane.cwd ?? ""}`}
                  onClick={() => terminals.selectTerminal(threadKey, pane.sessionId)} onKeyDown={(event) => {
                    navigate(event, index);
                    if (event.key === "F2") { event.preventDefault(); setEditing(pane.sessionId); setName(label); }
                    if (event.key === "Delete") { event.preventDefault(); terminals.closeTerminal(pane); }
                  }} onDoubleClick={() => { setEditing(pane.sessionId); setName(label); }}>
                  <span>{label}</span><small>{status}{pane.remote ? ` · ${pane.remote.instanceLabel}` : ""}</small>
                </button>;
            })}
          </div>
          <div className="thread-terminal-panel__close-list">
            {panes.map((pane, index) => {
              const label = pane.name || (pane.shell ? `${pane.shell.split(/[/\\]/).pop()} ${index + 1}` : `Terminal ${index + 1}`);
              return <button key={pane.sessionId} type="button" className="thread-terminal-panel__close"
                aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => terminals.closeTerminal(pane)}>×</button>;
            })}
          </div>
          </div>
          {editing ? <form className="thread-terminal-panel__rename" onSubmit={(event) => { event.preventDefault(); saveName(); }}>
            <input aria-label="Terminal name" autoFocus value={name} maxLength={80}
              onChange={(event) => setName(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Escape") { event.preventDefault(); setEditing(undefined); }
              }} />
            <button type="submit">Save</button>
          </form> : selected ? <button type="button" className="thread-terminal-panel__rename-button"
            onClick={() => { setEditing(selected.sessionId); setName(selected.name ?? ""); }}>Rename terminal</button> : null}
        </aside>
      </div>
    </section>
  );
}
