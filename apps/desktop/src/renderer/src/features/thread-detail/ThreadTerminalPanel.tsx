import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { IntegratedTerminal } from "./IntegratedTerminal";
import { InstanceChip } from "../federation/InstanceGlyph";
import type { DesktopApi } from "../../lib/desktop-api";
import type { IntegratedTerminalPane, IntegratedTerminalsController } from "../../lib/useIntegratedTerminals";

type TerminalState = "starting" | "running" | "unseen" | "exited" | "failed" | "saved";

function terminalState(pane: IntegratedTerminalPane, unseen: boolean): TerminalState {
  if (pane.pending) return "starting";
  if (pane.status === "restored") return "saved";
  if (pane.status === "exited") return pane.exitCode ? "failed" : "exited";
  return unseen ? "unseen" : "running";
}

const STATE_WORD: Record<TerminalState, string> = {
  starting: "Starting",
  running: "Running",
  unseen: "Running, new output",
  exited: "Exited",
  failed: "Exited",
  saved: "Saved output",
};

/** The row's second line: where a live shell runs, or how it ended. */
function terminalDetail(pane: IntegratedTerminalPane, state: TerminalState): string {
  if (state === "starting") return "Starting…";
  if (state === "failed") return `Exited · code ${pane.exitCode}`;
  if (state === "exited" || state === "saved") return STATE_WORD[state];
  return homeRelative(pane.cwd) ?? STATE_WORD[state];
}

function homeRelative(cwd: string | undefined): string | undefined {
  return cwd
    ?.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}

/** What a strip tile can fit: the first character, plus a trailing number
 * ("zsh 2" draws "z2"). */
function terminalMonogram(label: string): string {
  const number = /\s(\d+)$/.exec(label)?.[1] ?? "";
  return `${[...label.trim()][0] ?? "?"}${number}`;
}

function terminalLabel(pane: IntegratedTerminalPane, ordinal: number): string {
  if (pane.name) return pane.name;
  const base = pane.shell?.split(/[/\\]/).pop()?.replace(/\.exe$/i, "") || "Terminal";
  return ordinal > 1 ? `${base} ${ordinal}` : base;
}

/** A default name keeps its number for the terminal's life ("zsh", "zsh 2",
 * ...). A number frees only when its own terminal closes or is named, so
 * closing a sibling never renames a running shell. */
function useStableOrdinals(panes: IntegratedTerminalPane[]): ReadonlyMap<string, number> {
  const ordinalsRef = useRef(new Map<string, number>());
  const ordinals = ordinalsRef.current;
  const present = new Set(panes.filter((pane) => !pane.name).map((pane) => pane.sessionId));
  for (const sessionId of [...ordinals.keys()]) {
    if (!present.has(sessionId)) ordinals.delete(sessionId);
  }
  for (const pane of panes) {
    if (pane.name || ordinals.has(pane.sessionId)) continue;
    const used = new Set(ordinals.values());
    let next = 1;
    while (used.has(next)) next += 1;
    ordinals.set(pane.sessionId, next);
  }
  return ordinals;
}

const ICON_PROPS = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function ThreadTerminalPanel({ desktopApi, terminals, threadKey, panes, visible }: {
  desktopApi?: DesktopApi;
  terminals: IntegratedTerminalsController;
  threadKey: string;
  panes: IntegratedTerminalPane[];
  visible: boolean;
}) {
  const height = terminals.heightByThread[threadKey] ?? 260;
  const selected = panes.find((pane) => pane.sessionId === terminals.selectedByThread[threadKey]) ?? panes[0];
  const selectedId = selected?.sessionId;
  const remote = panes[0]?.remote;
  const ordinals = useStableOrdinals(panes);
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [hot, setHot] = useState<string>();
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(() => new Set());
  const [focusRequest, setFocusRequest] = useState<{ sessionId: string; count: number }>();
  const expanded = terminals.railExpanded;
  const listRef = useRef<HTMLDivElement>(null);
  const cancelRenameRef = useRef(false);

  useEffect(() => {
    if (!visible || !selectedId) return;
    setUnseen((current) => {
      if (!current.has(selectedId)) return current;
      const next = new Set(current);
      next.delete(selectedId);
      return next;
    });
  }, [visible, selectedId]);

  const markUnseen = (sessionId: string) => setUnseen((current) =>
    current.has(sessionId) ? current : new Set(current).add(sessionId));
  const focusTab = (index: number) =>
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
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
    focusTab(next);
  };
  /** A click on a tab means "take me to that shell": select it and put the
   *  keyboard in it. Arrow keys still move through the list without leaving. */
  const openTerminal = (pane: IntegratedTerminalPane) => {
    terminals.selectTerminal(threadKey, pane.sessionId);
    setFocusRequest((current) => ({ sessionId: pane.sessionId, count: (current?.count ?? 0) + 1 }));
  };
  const startRename = (pane: IntegratedTerminalPane, label: string) => {
    // Renaming needs the names, so a strip widens to the full list.
    terminals.setRailExpanded(true);
    cancelRenameRef.current = false;
    setEditing(pane.sessionId);
    setName(label);
  };
  const finishRename = (save: boolean) => {
    if (!editing) return;
    // The input unmounts next; a blur it raises on the way out must not save again.
    cancelRenameRef.current = true;
    const index = panes.findIndex((pane) => pane.sessionId === editing);
    if (save && name.trim()) terminals.renameTerminal(editing, name.trim());
    setEditing(undefined);
    requestAnimationFrame(() => focusTab(index));
  };
  const labels = panes.map((pane) => terminalLabel(pane, ordinals.get(pane.sessionId) ?? 1));
  const states = panes.map((pane) => terminalState(pane, unseen.has(pane.sessionId)));
  const editingIndex = panes.findIndex((pane) => pane.sessionId === editing);

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
          {panes.map((pane, index) => {
            const state = states[index]!;
            const ended = state === "exited" || state === "failed" || state === "saved";
            return (
              <div key={pane.sessionId} role="tabpanel" id={`terminal-panel-${pane.sessionId}`}
                aria-labelledby={`terminal-tab-${pane.sessionId}`} hidden={pane !== selected}>
                <IntegratedTerminal desktopApi={desktopApi} threadKey={threadKey} sessionId={pane.sessionId}
                  attachOnly={!pane.pending} newSession={pane.newSession} cwd={pane.cwd} remote={pane.remote} height={height} chrome="hosted"
                  visible={visible && pane === selected} onClose={() => terminals.closeTerminal(pane)}
                  onExit={() => terminals.handleExit(threadKey)} onHiddenOutput={() => markUnseen(pane.sessionId)}
                  focusRequest={focusRequest?.sessionId === pane.sessionId ? focusRequest.count : undefined} />
                {ended ? (
                  <div className="thread-terminal-panel__ended">
                    <span className={`thread-terminal-panel__dot is-${state}`} aria-hidden="true" />
                    <span className="thread-terminal-panel__ended-text">
                      <b>{state === "failed" ? `Exited with code ${pane.exitCode}` : state === "saved" ? "Saved output" : "Shell exited"}</b>
                      {state === "saved" ? <span> · from an earlier session, no shell is running</span> : null}
                    </span>
                    <button type="button" className="thread-terminal-panel__new-here"
                      onClick={() => terminals.createTerminal(threadKey, pane.cwd, pane.remote)}>
                      <svg {...ICON_PROPS}><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 3v2.4h2.4" /></svg>
                      New shell here
                    </button>
                    <button type="button" className="thread-terminal-panel__end-close"
                      onClick={() => terminals.closeTerminal(pane)}>
                      Close
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <aside className={expanded ? "thread-terminal-panel__sidebar" : "thread-terminal-panel__sidebar is-compact"}
          aria-label="Terminal sessions">
          <div className="thread-terminal-panel__actions">
            <span className="thread-terminal-panel__eyebrow">Terminals</span>
            {panes.length > 1 ? <span className="thread-terminal-panel__count" aria-hidden="true">{panes.length}</span> : null}
            <button type="button" className="tooltip-target thread-terminal-panel__expand" aria-expanded={expanded}
              aria-label={expanded ? "Collapse terminal list" : "Expand terminal list"}
              data-tooltip={expanded ? "Collapse terminal list" : "Expand terminal list"}
              onClick={() => terminals.setRailExpanded(!expanded)}>
              <svg {...ICON_PROPS}><path d={expanded ? "M6 4l4 4-4 4" : "M10 4L6 8l4 4"} /></svg>
            </button>
            <button type="button" className="tooltip-target" aria-label="New terminal" data-tooltip="New terminal"
              onClick={() => terminals.createTerminal(threadKey, selected?.cwd, selected?.remote)}>
              <svg {...ICON_PROPS}><path d="M8 3v10M3 8h10" /></svg>
            </button>
            <button type="button" className="tooltip-target" aria-label="Hide terminals" data-tooltip="Hide terminals"
              onClick={() => terminals.togglePanel(threadKey, selected?.cwd, selected?.remote)}>
              <svg {...ICON_PROPS}><path d="M4 6l4 4 4-4" /></svg>
            </button>
          </div>
          {remote ? (
            <div className="thread-terminal-panel__instance">
              <InstanceChip icon={remote.celestialIcon} instanceId={remote.instanceId} label={remote.instanceLabel} />
            </div>
          ) : null}
          <div className="thread-terminal-panel__list">
            <div ref={listRef} role="tablist" aria-label="Terminals" aria-orientation="vertical">
              {panes.map((pane, index) => {
                const label = labels[index]!;
                const state = states[index]!;
                const detail = terminalDetail(pane, state);
                return (
                  <button className="thread-terminal-panel__row" key={pane.sessionId} type="button" role="tab" id={`terminal-tab-${pane.sessionId}`}
                    aria-controls={`terminal-panel-${pane.sessionId}`} aria-selected={pane === selected}
                    tabIndex={pane === selected ? 0 : -1}
                    title={`${label} · ${state === "failed" ? `Exited with code ${pane.exitCode}` : STATE_WORD[state]}\n${remote?.instanceLabel ?? "This machine"}${pane.cwd ? `\n${pane.cwd}` : ""}\nDouble-click or F2 to rename`}
                    onClick={() => openTerminal(pane)}
                    onPointerEnter={() => setHot(pane.sessionId)} onPointerLeave={() => setHot(undefined)}
                    onFocus={() => setHot(pane.sessionId)} onBlur={() => setHot(undefined)}
                    onKeyDown={(event) => {
                      navigate(event, index);
                      if (event.key === "F2") { event.preventDefault(); startRename(pane, label); }
                      if (event.key === "Delete") { event.preventDefault(); terminals.closeTerminal(pane); }
                    }} onDoubleClick={() => startRename(pane, label)}>
                    <span className={`thread-terminal-panel__dot is-${state}`} aria-hidden="true" />
                    <span className="thread-terminal-panel__tile" aria-hidden="true">
                      {terminalMonogram(label)}
                      <span className={`thread-terminal-panel__dot is-${state}`} />
                    </span>
                    <span className="thread-terminal-panel__text">
                      <span className="thread-terminal-panel__name">{label}</span>
                      <small className={state === "failed" ? "is-failed" : undefined}>{detail}</small>
                      {detail !== STATE_WORD[state] && state !== "starting"
                        ? <span className="thread-terminal-panel__state">, {STATE_WORD[state]}</span>
                        : null}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="thread-terminal-panel__close-list">
              {panes.map((pane, index) => (
                <button key={pane.sessionId} type="button"
                  className={`thread-terminal-panel__close tooltip-target${pane === selected || hot === pane.sessionId ? " is-shown" : ""}`}
                  aria-label={`Close ${labels[index]}`} data-tooltip={`Close ${labels[index]}`}
                  onPointerEnter={() => setHot(pane.sessionId)} onPointerLeave={() => setHot(undefined)}
                  onClick={() => terminals.closeTerminal(pane)}>
                  <svg {...ICON_PROPS}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
                </button>
              ))}
            </div>
            {editing && editingIndex >= 0 ? (
              <form className="thread-terminal-panel__rename" style={{ "--row-index": editingIndex } as CSSProperties}
                onSubmit={(event) => { event.preventDefault(); finishRename(true); }}>
                <input aria-label="Terminal name" autoFocus value={name} maxLength={80}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={() => { if (!cancelRenameRef.current) finishRename(true); }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      finishRename(false);
                    }
                  }} />
              </form>
            ) : null}
          </div>
        </aside>
      </div>
    </section>
  );
}
