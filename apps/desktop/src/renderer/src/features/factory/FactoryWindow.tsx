import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type {
  FactoryProjectOption, FactoryProjectProjection, FactoryProjectReadRequest,
  FactoryEvidenceSnapshot,
} from "@pwragent/shared/factory-projection";
import { SignalCount } from "../../components/SignalCount";
import { useDesktopApi } from "../../lib/desktop-api";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { BrandLockup } from "../chrome/BrandLockup";
import { FactoryDecisionDrawer } from "./FactoryDecisionDrawer";
import { FactoryObservationTime } from "./FactoryObservationTime";
import { FactoryProjectForm } from "./FactoryProjectForm";
import { FACTORY_LANES, factoryRows, type FactoryRow } from "./factory-board";
import { useFactoryReads } from "./useFactoryReads";
import "./factory.css";

export function FactoryWindow() {
  const api = useDesktopApi();
  const list = api?.listFactoryProjects;
  const [projects, setProjects] = useState<FactoryProjectOption[]>();
  const [listError, setListError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [listing, setListing] = useState(true);
  useEffect(() => {
    let active = true;
    if (list) void list().then(
      (result) => {
        if (!active) return;
        setProjects(result);
        setListing(false);
      },
      () => {
        if (!active) return;
        setListError(true);
        setListing(false);
      },
    );
    return () => { active = false; };
  }, [list, retry]);

  function refreshProjects() {
    setListing(true);
    setListError(false);
    setRetry((value) => value + 1);
  }

  const refresh = (
    <button className="button button--secondary" type="button" onClick={refreshProjects} disabled={listing}>
      Refresh projects
    </button>
  );

  return (
    <main className="document-window factory-window" aria-label="Factory">
      <header className="activity-titlebar">
        <BrandLockup variant="activity-titlebar" />
        <div className="activity-titlebar__breadcrumb">
          <span className="activity-titlebar__eyebrow">Factory</span>
        </div>
      </header>
      {!list || !api?.readFactoryProject || !api.openFactoryThread ? (
        <p className="factory-initial" role="status">Factory is unavailable in this window.</p>
      ) : projects?.length ? (
        <FactoryBoard projects={projects} read={api.readFactoryProject} openThread={api.openFactoryThread}
          refresh={refresh} listError={listError} />
      ) : projects || listError ? (
        <div className="factory-initial">
          <h1>Factory board</h1>
          {listError ? <p role="alert">Could not load registered projects.</p>
            : <p>Register a project in the Directories lens to read its Factory evidence.</p>}
          {refresh}
        </div>
      ) : (
        <p className="factory-initial" role="status">Loading registered projects…</p>
      )}
    </main>
  );
}

type Selection = { key: string; number?: number; repositoryId?: string };

function FactoryBoard(props: {
  projects: FactoryProjectOption[];
  read: (request: FactoryProjectReadRequest) => Promise<FactoryProjectProjection>;
  openThread: (reference: string) => Promise<void>;
  refresh: ReactNode;
  listError: boolean;
}) {
  const reads = useFactoryReads(props.read);
  const { error, pending, readPr, readScope } = reads;
  const label = props.projects.find((project) => project.key === reads.board?.scope.projectKey)?.label;
  const board = label === undefined ? undefined : reads.board;
  const [online, setOnline] = useState(() => navigator.onLine);
  const [selection, setSelection] = useState<Selection>();
  const drawerRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const queueRef = useRef<HTMLElement>(null);
  const restore = useRef<Selection | undefined>(undefined);
  const attempted = useRef<Selection | undefined>(undefined);
  useEffect(() => {
    const change = () => setOnline(navigator.onLine);
    window.addEventListener("online", change);
    window.addEventListener("offline", change);
    return () => {
      window.removeEventListener("online", change);
      window.removeEventListener("offline", change);
    };
  }, []);
  const evidence = new Map<number, FactoryEvidenceSnapshot>();
  for (const [number, info] of board?.details ?? []) {
    if (info.evidence) evidence.set(number, info.evidence);
  }
  const rows = factoryRows(board?.inventory, board?.branch, evidence);
  const repositoryId = board?.inventory?.repository.id;
  const requestedNumber = selection?.repositoryId === repositoryId ? selection?.number : undefined;
  const selected = selection && rows.find((row) => row.key === selection.key
    || (requestedNumber !== undefined && row.pr?.number === requestedNumber));
  useEffect(() => {
    if (!selection || requestedNumber === undefined || !online || pending
      || attempted.current === selection || board?.details.has(requestedNumber)) return;
    // One read at a time. If the operator changed rows during an earlier read,
    // start only the current selection when the owner becomes available.
    attempted.current = selection;
    void readPr(requestedNumber, false);
  }, [board?.details, online, pending, readPr, requestedNumber, selection]);
  const prNumber = selected?.pr?.number;
  const detail = prNumber === undefined ? undefined : board?.details.get(prNumber);
  const workItem = selected?.branch?.workItem;
  const trackedPr = !selected?.pr && workItem?.provider === "github" && workItem.kind === "pull_request"
    ? workItem : undefined;
  const trackedDetail = trackedPr && trackedPr.repositoryId === repositoryId
    ? board?.details.get(trackedPr.number) : undefined;
  const open = Boolean(selected);
  useDismissableLayer({ open, onDismiss: close, surfaceRef: drawerRef });
  useLayoutEffect(() => {
    if (open) {
      titleRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!restore.current) return;
    const { key, number } = restore.current;
    restore.current = undefined;
    const targets = Array.from(queueRef.current?.querySelectorAll<HTMLButtonElement>("[data-row-key]") ?? []);
    const target = targets.find((item) => item.dataset.rowKey === key
      || (number !== undefined && item.dataset.prNumber === String(number)));
    (target ?? queueRef.current)?.focus();
  }, [open, selection]);

  return (
    <div className="factory-screen" data-drawer={open}>
      <header className="factory-heading">
        <div>
          <h1>Factory board</h1>
          <p>{board
            ? `${label} · ${board.repository.owner}/${board.repository.name}`
            : "Select a registered project and repository."}</p>
        </div>
        {board?.inventory ? (
          <FactoryObservationTime label="Pull request inventory observed" value={board.inventory.authority.observedAt} />
        ) : null}
      </header>
      <details className="factory-scope" open={!board}>
        <summary>Project and evidence source</summary>
        <FactoryProjectForm projects={props.projects} busy={pending} online={online} refresh={props.refresh}
          observedRepository={board && repositoryId ? { scope: board.scope, id: repositoryId } : undefined}
          onRead={(scope, candidate) => {
            setSelection(undefined);
            void readScope(scope, candidate);
          }} />
      </details>

      {props.listError ? <p className="factory-banner" role="alert">Could not load registered projects.</p> : null}
      {!online ? <p className="factory-banner">Network offline. Local branch evidence is still available.</p> : null}
      {error ? <p className="factory-banner" role="alert">{error}{board ? " Showing last confirmed evidence." : ""}</p> : null}
      {pending ? <p className="factory-banner" role="status">Reading Factory evidence…</p> : null}
      <div className="factory-workspace">
        <section className="factory-queue" aria-label="Outcomes" tabIndex={-1} ref={queueRef} onKeyDown={moveRowFocus}>
          {board?.inventory?.truncated ? <p className="factory-queue-note">Showing the newest {board.inventory.pullRequests.length} open pull requests.</p> : null}
          {board && !rows.length ? <p className="factory-queue-note">No open pull requests in this repository.</p> : null}
          {board?.branch && !board.inventory ? <p className="factory-queue-note">Local evidence · pull requests have yet to be read.</p> : null}
          {FACTORY_LANES.map((lane) => {
            const matches = rows.filter((row) => row.lane === lane);
            return (
              <section className="factory-lane" key={lane} aria-label={lane}>
                <h2>
                  {lane}
                  <SignalCount count={matches.length} tone={matches.length && lane === "Needs you" ? "active" : "idle"}
                    indicator={<span className="factory-lane-mark" data-lane={lane} />} />
                </h2>
                {matches.length ? (
                  <ul>{matches.map((row) => (
                    <li key={row.key}>
                      <button className="factory-row" type="button" aria-expanded={selected?.key === row.key}
                        aria-controls={selected?.key === row.key ? "factory-drawer" : undefined}
                        data-row-key={row.key} data-pr-number={row.pr?.number}
                        onClick={() => select(row)}>
                        <span className="factory-row-text">
                          <strong>{row.title}</strong>{" "}
                          <span className="factory-context">{row.context}</span>
                        </span>{" "}
                        <span className="factory-row-reason">{row.reason}</span>
                      </button>
                    </li>
                  ))}</ul>
                ) : <p className="factory-lane-empty">No outcomes</p>}
              </section>
            );
          })}
        </section>
        {selected ? (
          <FactoryDecisionDrawer key={selection?.key} row={selected}
            evidence={detail?.evidence ?? (selected.branch ? board?.branch?.linked : undefined)} expected={detail?.expected}
            checks={detail?.checks} unavailable={detail?.unavailable ?? trackedDetail?.unavailable}
            observedAt={detail?.observedAt}
            trackedNumber={trackedPr?.number}
            busy={pending} online={online} canCompare={!!board?.branch && !!selected.pr && !selected.branch}
            drawerRef={drawerRef} titleRef={titleRef} onClose={close}
            openThread={props.openThread}
            onCompare={() => {
              if (trackedPr) void readPr(trackedPr.number, true, undefined, trackedPr.repositoryId);
              else if (prNumber !== undefined) void readPr(prNumber, true);
            }}
            onRefresh={(checks) => {
              if (prNumber !== undefined) void readPr(prNumber, false, checks);
              else if (board?.branch) void readScope(board.scope, board.branch.request);
            }} />
        ) : null}
      </div>
    </div>
  );

  function select(row: FactoryRow) {
    setSelection({ key: row.key, number: row.pr?.number, repositoryId });
  }

  function close() {
    restore.current = selected ?? selection;
    setSelection(undefined);
  }
}

function moveRowFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") return;
  const targets = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-row-key]"));
  const current = targets.findIndex((target) => target === event.target);
  if (current === -1) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? targets.length - 1
    : Math.max(0, Math.min(targets.length - 1, current + (event.key === "ArrowUp" ? -1 : 1)));
  event.preventDefault();
  targets[next]?.focus();
}
