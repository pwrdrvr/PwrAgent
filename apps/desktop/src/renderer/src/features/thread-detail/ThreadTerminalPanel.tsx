import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import { IntegratedTerminal } from "./IntegratedTerminal";
import { InstanceChip } from "../federation/InstanceGlyph";
import { copyText } from "../../lib/copy-text";
import { tildifyPath } from "../../lib/tildify-path";
import type { DesktopApi } from "../../lib/desktop-api";
import { useDismissOnOutsidePointer } from "../../lib/useDismissOnOutsidePointer";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
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
  saved: "Saved history",
};

/** The row's second line: where a live shell runs, or how it ended. */
function terminalDetail(pane: IntegratedTerminalPane, state: TerminalState): string {
  if (state === "starting") return "Starting…";
  if (state === "failed") return `Exited · code ${pane.exitCode}`;
  if (state === "saved") return "Resumes when opened";
  if (state === "exited") return STATE_WORD[state];
  return pane.cwd ? tildifyPath(pane.cwd) : STATE_WORD[state];
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

/** Hover intent for the rail: open after a short dwell so a pointer passing
 * through to the terminal's scrollbar does not flash it, close after a short
 * grace so a diagonal move toward a name does not drop it. */
const RAIL_OPEN_DELAY_MS = 120;
const RAIL_CLOSE_DELAY_MS = 180;

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
  /** Restarts per terminal. Each one remounts that pane asking main to start a
   *  shell under the same id, below the saved history. */
  const [restarts, setRestarts] = useState<Readonly<Record<string, number>>>({});
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number }>();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const pointerFocusRef = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const cancelRenameRef = useRef(false);
  const menuIndex = menu ? panes.findIndex((pane) => pane.sessionId === menu.sessionId) : -1;
  // The menu's terminal can go away under it (closed elsewhere, or a remote
  // owner reaped it). Drop the menu too, or it would hold the rail open and
  // keep a dismissable layer registered with nothing on screen.
  useEffect(() => {
    if (menu && menuIndex < 0) setMenu(undefined);
  }, [menu, menuIndex]);
  const menuOpen = menuIndex >= 0;
  const open = hovered || focusWithin || editing !== undefined || menuOpen;
  const closeMenu = useCallback(() => setMenu(undefined), []);
  useMenuNavigation({ open: menuOpen, menuRef, triggerRef: menuTriggerRef, onClose: closeMenu });
  useDismissOnOutsidePointer(menuOpen, menuRef, closeMenu);
  // Keep the menu on screen: it opens to the left of the pointer (the rail
  // sits at the right edge) and moves up when it would run off the bottom.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) return;
    const overflow = element.getBoundingClientRect().bottom - window.innerHeight + 8;
    element.style.top = `${overflow > 0 ? menu.y - overflow : menu.y}px`;
  }, [menu]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  useEffect(() => {
    if (!visible || !selectedId) return;
    setUnseen((current) => {
      if (!current.has(selectedId)) return current;
      const next = new Set(current);
      next.delete(selectedId);
      return next;
    });
  }, [visible, selectedId]);

  // Saved history comes back as a working shell the first time it is shown,
  // not as a dead screen with a button. Lazy, so a relaunch does not start a
  // login shell for every terminal of every thread at once.
  const selectedStatus = selected?.status;
  useEffect(() => {
    if (!visible || !selectedId || selectedStatus !== "restored") return;
    setRestarts((current) => current[selectedId] ? current : { ...current, [selectedId]: 1 });
  }, [visible, selectedId, selectedStatus]);

  const hover = (next: boolean) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHovered(next), next ? RAIL_OPEN_DELAY_MS : RAIL_CLOSE_DELAY_MS);
  };
  const restart = (pane: IntegratedTerminalPane) => {
    setRestarts((current) => ({ ...current, [pane.sessionId]: (current[pane.sessionId] ?? 0) + 1 }));
    setFocusRequest((current) => ({ sessionId: pane.sessionId, count: (current?.count ?? 0) + 1 }));
  };
  const openMenu = (event: MouseEvent<HTMLButtonElement>, pane: IntegratedTerminalPane) => {
    event.preventDefault();
    menuTriggerRef.current = event.currentTarget;
    // The Menu key and Shift+F10 report no pointer position: anchor to the tab.
    const rect = event.currentTarget.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    setMenu({
      sessionId: pane.sessionId,
      x: fromKeyboard ? rect.right : event.clientX,
      y: fromKeyboard ? rect.bottom : event.clientY,
    });
  };
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
            const ended = state === "exited" || state === "failed";
            const restartCount = restarts[pane.sessionId] ?? 0;
            return (
              <div key={pane.sessionId} role="tabpanel" id={`terminal-panel-${pane.sessionId}`}
                aria-labelledby={`terminal-tab-${pane.sessionId}`} hidden={pane !== selected}>
                <IntegratedTerminal key={restartCount} desktopApi={desktopApi} threadKey={threadKey} sessionId={pane.sessionId}
                  attachOnly={!pane.pending} newSession={pane.newSession} cwd={pane.cwd} remote={pane.remote} height={height} chrome="hosted"
                  resume={restartCount > 0}
                  visible={visible && pane === selected} onClose={() => terminals.closeTerminal(pane)}
                  onExit={() => terminals.handleExit(threadKey)} onHiddenOutput={() => markUnseen(pane.sessionId)}
                  focusRequest={focusRequest?.sessionId === pane.sessionId ? focusRequest.count : undefined} />
                {ended ? (
                  <div className="thread-terminal-panel__ended">
                    <span className={`thread-terminal-panel__dot is-${state}`} aria-hidden="true" />
                    <span className="thread-terminal-panel__ended-text">
                      <b>{state === "failed" ? `Exited with code ${pane.exitCode}` : "Shell exited"}</b>
                    </span>
                    <button type="button" className="thread-terminal-panel__new-here" onClick={() => restart(pane)}>
                      <svg {...ICON_PROPS}><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 3v2.4h2.4" /></svg>
                      Restart shell
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
        {/* The aside holds the strip's 40px in the layout. The rail inside it
            flies out over the terminal, so the shell never reflows. */}
        <aside className="thread-terminal-panel__sidebar" aria-label="Terminal sessions">
          <div ref={railRef} className={open ? "thread-terminal-panel__rail is-open" : "thread-terminal-panel__rail"}
            onPointerEnter={() => hover(true)} onPointerLeave={() => hover(false)}
            onPointerDown={() => { pointerFocusRef.current = true; }}
            onPointerUp={() => { pointerFocusRef.current = false; }}
            onFocus={() => {
              // Only keyboard focus opens the rail. A click focuses its tab on
              // mousedown, and opening then would slide the rail out under a
              // pointer that has not let go yet. Hover opens it for pointers.
              if (pointerFocusRef.current) return;
              setFocusWithin(true);
            }}
            onBlur={(event) => {
              if (!railRef.current?.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
            }}>
            <div className="thread-terminal-panel__actions">
              <span className="thread-terminal-panel__heading">
                <span className="thread-terminal-panel__eyebrow">Terminals</span>
                {panes.length > 1 ? <span className="thread-terminal-panel__count" aria-hidden="true">{panes.length}</span> : null}
                {remote ? (
                  <InstanceChip icon={remote.celestialIcon} instanceId={remote.instanceId} label={remote.instanceLabel} />
                ) : null}
              </span>
              <button type="button" className="tooltip-target" aria-label="New terminal" data-tooltip="New terminal"
                onClick={() => terminals.createTerminal(threadKey, selected?.cwd, selected?.remote)}>
                <svg {...ICON_PROPS}><path d="M8 3v10M3 8h10" /></svg>
              </button>
            </div>
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
                      onClick={() => openTerminal(pane)}
                      onPointerEnter={() => setHot(pane.sessionId)} onPointerLeave={() => setHot(undefined)}
                      onFocus={() => setHot(pane.sessionId)} onBlur={() => setHot(undefined)}
                      onKeyDown={(event) => {
                        navigate(event, index);
                        if (event.key === "F2") { event.preventDefault(); startRename(pane, label); }
                        if (event.key === "Delete") { event.preventDefault(); terminals.closeTerminal(pane); }
                      }} onDoubleClick={() => startRename(pane, label)}
                      onContextMenu={(event) => openMenu(event, pane)}>
                      <span className="thread-terminal-panel__text">
                        <span className="thread-terminal-panel__name">{label}</span>
                        <small className={state === "failed" ? "is-failed" : undefined}>{detail}</small>
                        {detail !== STATE_WORD[state] && state !== "starting"
                          ? <span className="thread-terminal-panel__state">, {STATE_WORD[state]}</span>
                          : null}
                      </span>
                      <span className="thread-terminal-panel__tile" aria-hidden="true">
                        {terminalMonogram(label)}
                        <span className={`thread-terminal-panel__dot is-${state}`} />
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
                    tabIndex={open ? 0 : -1}
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
          </div>
        </aside>
      </div>
      {menu && menuOpen ? createPortal(<TerminalMenu
        menuRef={menuRef}
        menu={menu}
        pane={panes[menuIndex]!}
        label={labels[menuIndex]!}
        state={states[menuIndex]!}
        onClose={closeMenu}
        onRename={(pane, label) => startRename(pane, label)}
        onCopyPath={(pane) => { if (pane.cwd) void copyText(pane.cwd, desktopApi); }}
        onNewHere={(pane) => terminals.createTerminal(threadKey, pane.cwd, pane.remote)}
        onRestart={restart}
        onCloseTerminal={(pane) => terminals.closeTerminal(pane)}
      />, document.body) : null}
    </section>
  );
}

function TerminalMenu({ menuRef, menu, pane, label, state, onClose, onRename, onCopyPath, onNewHere, onRestart, onCloseTerminal }: {
  menuRef: RefObject<HTMLDivElement | null>;
  menu: { x: number; y: number };
  pane: IntegratedTerminalPane;
  label: string;
  state: TerminalState;
  onClose: () => void;
  onRename: (pane: IntegratedTerminalPane, label: string) => void;
  onCopyPath: (pane: IntegratedTerminalPane) => void;
  onNewHere: (pane: IntegratedTerminalPane) => void;
  onRestart: (pane: IntegratedTerminalPane) => void;
  onCloseTerminal: (pane: IntegratedTerminalPane) => void;
}) {
  const ended = state === "exited" || state === "failed" || state === "saved";
  const act = (run: () => void) => () => { onClose(); run(); };
  return (
    <div ref={menuRef} className="terminal-menu" role="menu" aria-label={`${label} terminal`} tabIndex={-1}
      style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" className="terminal-menu__item" onClick={act(() => onRename(pane, label))}>
        Rename<kbd>F2</kbd>
      </button>
      <button type="button" role="menuitem" className="terminal-menu__item" disabled={!pane.cwd}
        onClick={act(() => onCopyPath(pane))}>
        Copy path
      </button>
      <button type="button" role="menuitem" className="terminal-menu__item" onClick={act(() => onNewHere(pane))}>
        New terminal here
      </button>
      {ended ? (
        <button type="button" role="menuitem" className="terminal-menu__item" onClick={act(() => onRestart(pane))}>
          Restart shell
        </button>
      ) : null}
      <div className="terminal-menu__separator" role="separator" />
      <button type="button" role="menuitem" className="terminal-menu__item is-danger" onClick={act(() => onCloseTerminal(pane))}>
        Close terminal<kbd>Del</kbd>
      </button>
    </div>
  );
}
