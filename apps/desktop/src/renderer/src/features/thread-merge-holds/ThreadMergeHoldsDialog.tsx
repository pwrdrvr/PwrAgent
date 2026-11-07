import { useCallback, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  THREAD_MERGE_HOLD_FOLLOW_UP_STEP_MAX_LENGTH,
  THREAD_MERGE_HOLD_MAX_FOLLOW_UP_STEPS,
  type ManageThreadMergeHoldsRequest,
  type NavigationThreadSummary,
  type ThreadMergeHold,
} from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { useModalDialog } from "../../lib/useModalDialog";
import { useThreadLinks } from "../../lib/thread-links";
import { ThreadChip } from "../thread-detail/ThreadChip";
import { ThreadSearchPicker } from "../thread-search/ThreadSearchPicker";
import { mergeHoldDependencyCandidates, type WaitingThread } from "./merge-hold-dependency";
import { useThreadMergeHolds } from "./useThreadMergeHolds";

type Dependency = NonNullable<ThreadMergeHold["dependency"]>;
type ChosenDependency = { dependency: Dependency; thread: NavigationThreadSummary };

/** This window's own machine; without an id, a peer's thread cannot wait on a thread here. */
export type MergeHoldsLocalMachine = { instanceId?: string; label: string };

const NO_THREADS: readonly NavigationThreadSummary[] = [];

type Clearing = {
  hold: ThreadMergeHold;
  owner?: ManageThreadMergeHoldsRequest["federationTarget"];
  /** The hold belongs to another thread that waits on this one. */
  dependent: boolean;
};

/** One step per line; blank lines are dropped. */
export function parseFollowUpSteps(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);
}

function FollowUpSteps({ hold }: { hold: ThreadMergeHold }) {
  if (!hold.followUp?.length) return null;
  return (
    <div className="thread-merge-holds__then">
      <span>Then remind you to</span>
      <ol className="thread-merge-holds__steps">
        {hold.followUp.map((step, index) => <li key={index}>{step}</li>)}
      </ol>
      {hold.offerToSend ? <p className="thread-dependencies__hint">The reminder offers to send these steps to the thread.</p> : null}
    </div>
  );
}

/**
 * Waiting on: nothing, or the chosen thread. Choose Thread… opens the jump
 * palette's search in place, the same picker as a to-do card's destination.
 */
function WaitingOnField(props: {
  waiting: WaitingThread;
  chosen?: ChosenDependency;
  api?: DesktopApi;
  localMachine?: MergeHoldsLocalMachine;
  disabled: boolean;
  onChoose: (chosen: ChosenDependency | undefined) => void;
}) {
  const links = useThreadLinks();
  const [choosing, setChoosing] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const { waiting, localMachine, chosen } = props;
  const localInstanceId = localMachine?.instanceId;
  const toCandidates = useCallback(
    (threads: readonly NavigationThreadSummary[]) => mergeHoldDependencyCandidates(threads, waiting, localInstanceId),
    [waiting, localInstanceId],
  );
  const searchApi = props.api?.getNavigationQueryPage ? props.api : undefined;
  const ref = chosen?.thread.federation?.ref.target;
  const instanceId = ref?.scope === "remote" ? ref.instanceId : undefined;
  const link = chosen && (links?.resolve({ backend: chosen.dependency.backend, threadId: chosen.dependency.threadId, ...(instanceId ? { instanceId } : {}) })
    ?? { backend: chosen.dependency.backend, threadId: chosen.dependency.threadId, title: chosen.dependency.title ?? chosen.dependency.threadId, ...(instanceId ? { instanceId } : {}) });
  const machineLabel = chosen?.thread.federation?.instanceLabel ?? instanceId ?? localMachine?.label ?? "This machine";
  return (
    <div className="thread-dependencies__field" role="group" aria-labelledby={labelId}>
      <span id={labelId}>Waiting on another thread (optional)</span>
      <div className="thread-merge-holds__on-row">
        {chosen && link ? (
          <span className="thread-merge-holds__on-target">
            <ThreadChip link={link} fallbackLabel={chosen.dependency.title} onOpen={(value) => links?.show(value)} />
            <small>{formatBackendLabel(chosen.dependency.backend)} · {machineLabel}</small>
          </span>
        ) : <span className="thread-merge-holds__on-none">No thread chosen</span>}
        {searchApi ? (
          <button ref={toggleRef} className="button button--secondary" type="button" disabled={props.disabled} onClick={() => setChoosing(!choosing)}>
            {choosing ? "Cancel" : chosen ? "Change" : "Choose Thread…"}
          </button>
        ) : null}
        {chosen && !choosing ? (
          <button className="button button--secondary" type="button" disabled={props.disabled} onClick={() => props.onChoose(undefined)}>Remove</button>
        ) : null}
      </div>
      {!searchApi ? <p className="thread-dependencies__hint">Thread search is unavailable in this window.</p> : null}
      {choosing && searchApi ? (
        <ThreadSearchPicker
          toCandidates={toCandidates}
          fieldLabel="Find the thread to wait on"
          listLabel="Threads to wait on"
          disabled={props.disabled}
          api={searchApi}
          threads={links?.readLoadedThreads?.() ?? NO_THREADS}
          focusOnOpen
          onCancel={() => setChoosing(false)}
          triggerRef={toggleRef}
          onPick={(dependency, thread) => {
            props.onChoose({ dependency, thread });
            setChoosing(false);
            toggleRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

export function ThreadMergeHoldsDialog({ thread, api, localMachine, onClose }: {
  thread: NavigationThreadSummary;
  api?: DesktopApi;
  localMachine?: MergeHoldsLocalMachine;
  onClose: () => void;
}) {
  const target = thread.federation?.ref.target ?? readRendererFederationTarget();
  const { data, error: readError, refresh } = useThreadMergeHolds(thread.source, thread.id, target, api);
  const [reason, setReason] = useState("");
  const [followUpText, setFollowUpText] = useState("");
  const [offerToSend, setOfferToSend] = useState(false);
  const [chosen, setChosen] = useState<ChosenDependency>();
  const [note, setNote] = useState("");
  const [clearing, setClearing] = useState<Clearing>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState(false);
  const [creating, setCreating] = useState(false);
  const titleId = useId();
  const fieldId = useId();
  const ref = useModalDialog<HTMLElement>({ onClose: () => { if (!busy) onClose(); }, initialFocus: "dialog" });
  const links = useThreadLinks();
  const response = data;
  const holds = response?.holds ?? thread.mergeHolds ?? [];
  const active = holds.filter((hold) => hold.status === "waiting");
  const dependents = response?.dependents ?? [];
  const waiting = useWaitingThread(thread.source, thread.id, target);
  const followUp = parseFollowUpSteps(followUpText);
  const followUpTooLong = followUp.length > THREAD_MERGE_HOLD_MAX_FOLLOW_UP_STEPS
    || followUp.some((step) => step.length > THREAD_MERGE_HOLD_FOLLOW_UP_STEP_MAX_LENGTH);
  const threadName = thread.title || "This thread";

  const submit = async (request: ManageThreadMergeHoldsRequest) => {
    if (!api?.manageThreadMergeHolds) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.manageThreadMergeHolds(request);
      refresh();
      setCreating(false);
      setReason("");
      setFollowUpText("");
      setOfferToSend(false);
      setChosen(undefined);
      setNote("");
      setClearing(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const threadChip = (item: { backend: ThreadMergeHold["backend"]; threadId: string; title?: string }, instanceId?: string) => {
    const link = links?.resolve({ backend: item.backend, threadId: item.threadId, ...(instanceId ? { instanceId } : {}) })
      ?? { backend: item.backend, threadId: item.threadId, title: item.title ?? item.threadId, ...(instanceId ? { instanceId } : {}) };
    return <ThreadChip link={link} fallbackLabel={item.title} onOpen={(value) => links?.show(value)} />;
  };

  const dependencyChip = (hold: ThreadMergeHold) => {
    const prerequisite = hold.dependency;
    if (!prerequisite) return null;
    const instanceId = prerequisite.target.scope === "remote"
      ? prerequisite.target.instanceId
      : target?.scope === "remote" ? target.instanceId : undefined;
    return threadChip(prerequisite, instanceId);
  };

  const startClearing = (next: Clearing) => {
    setClearing(next);
    setNote("");
    setError(undefined);
  };

  const clear = (action: "resolve" | "cancel") => {
    if (!clearing) return;
    void submit({
      action, backend: clearing.hold.backend, threadId: clearing.hold.threadId,
      federationTarget: clearing.owner, holdId: clearing.hold.id, note,
    });
  };

  const create = () => {
    void submit({
      action: "create", backend: thread.source, threadId: thread.id, federationTarget: target, reason,
      ...(followUp.length ? { followUp } : {}),
      ...(followUp.length && offerToSend ? { offerToSend: true } : {}),
      ...(chosen ? { dependency: chosen.dependency } : {}),
    });
  };

  const showForm = !clearing && (creating || (!active.length && !dependents.length));

  return createPortal(
    <div className="rename-thread-backdrop" role="presentation">
      <section className="rename-thread-dialog thread-merge-holds" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="thread-merge-holds__header">
          <h2 id={titleId}>Wait Until Done</h2>
          <button className="button button--secondary" type="button" disabled={busy} onClick={onClose}>Done</button>
        </header>
        <p className="thread-merge-holds__subject" title={threadName}>{threadName}</p>
        <p className="thread-dependencies__hint">
          Replies, rebase and CI repair continue. Merging waits until the work is marked done, then you get a reminder. No turn starts.
        </p>
        {error || readError ? <p role="alert">{error ?? readError}</p> : null}

        {active.filter((hold) => hold.id !== clearing?.hold.id).map((hold) => (
          <div className="thread-merge-holds__entry" key={hold.id}>
            <div className="thread-merge-holds__heading">
              <strong>Waiting for {hold.reason}</strong>
              {hold.dependency ? <span className="thread-merge-holds__on">on {dependencyChip(hold)}</span> : null}
            </div>
            {hold.releaseWhen ? <p>Done when: {hold.releaseWhen}</p> : null}
            <FollowUpSteps hold={hold} />
            <button className="button button--secondary" type="button" disabled={busy} onClick={() => startClearing({ hold, owner: target, dependent: false })}>
              Mark Done…
            </button>
          </div>
        ))}

        {dependents.filter(({ hold }) => hold.id !== clearing?.hold.id).map(({ hold, owner }) => (
          <div className="thread-merge-holds__entry" key={`${owner?.scope === "remote" ? owner.instanceId : "local"}:${hold.id}`}>
            <div className="thread-merge-holds__heading">
              {threadChip({ backend: hold.backend, threadId: hold.threadId }, owner?.scope === "remote" ? owner.instanceId : undefined)}
              <strong>is waiting on this thread</strong>
            </div>
            <p>For {hold.reason}</p>
            <FollowUpSteps hold={hold} />
            <button className="button button--secondary" type="button" disabled={busy} onClick={() => startClearing({ hold, owner, dependent: true })}>
              Mark Done…
            </button>
          </div>
        ))}

        {clearing ? (
          <div className="thread-merge-holds__entry thread-dependencies__form">
            <strong>Waiting for {clearing.hold.reason}</strong>
            <label className="thread-dependencies__field">
              <span>{clearing.dependent ? "What finished" : "What finished, or why you stopped waiting"}</span>
              <textarea
                aria-describedby={`${fieldId}-done`}
                disabled={busy}
                maxLength={2000}
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <p className="thread-dependencies__hint" id={`${fieldId}-done`}>
              {clearing.hold.followUp?.length
                ? `Mark Done reminds you of ${clearing.hold.followUp.length === 1 ? "the next step" : `the ${clearing.hold.followUp.length} next steps`}, with this note.`
                : "Mark Done raises a reminder with this note."}
            </p>
            <div className="thread-merge-holds__actions">
              <button className="button button--primary" type="button" disabled={busy || !note.trim()} onClick={() => clear("resolve")}>Mark Done</button>
              {clearing.dependent ? null : (
                <button className="button button--secondary" type="button" disabled={busy || !note.trim()} onClick={() => clear("cancel")}>Stop Waiting</button>
              )}
              <button className="button button--secondary" type="button" disabled={busy} onClick={() => setClearing(undefined)}>Keep Waiting</button>
            </div>
          </div>
        ) : null}

        {showForm ? (
          <form className="thread-dependencies__form" onSubmit={(event) => { event.preventDefault(); create(); }}>
            <label className="thread-dependencies__field">
              <span>Waiting for</span>
              <textarea required rows={2} maxLength={2000} disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Windows validation of the shutdown fix" />
            </label>
            <WaitingOnField
              waiting={waiting}
              chosen={chosen}
              api={api}
              localMachine={localMachine}
              disabled={busy}
              onChoose={(next) => {
                setChosen(next);
                // A pick alone is enough to start: it names what is awaited.
                if (next?.dependency.title && !reason.trim()) setReason(next.dependency.title);
              }}
            />
            <label className="thread-dependencies__field">
              <span>When it’s done, remind me to</span>
              <textarea
                aria-describedby={`${fieldId}-steps`}
                rows={3}
                disabled={busy}
                value={followUpText}
                onChange={(event) => setFollowUpText(event.target.value)}
                placeholder={"Rebase onto the fix\nRe-run the Windows E2E lane\nMerge"}
              />
            </label>
            <p className="thread-dependencies__hint" id={`${fieldId}-steps`}>
              {followUpTooLong
                ? `Use at most ${THREAD_MERGE_HOLD_MAX_FOLLOW_UP_STEPS} steps of ${THREAD_MERGE_HOLD_FOLLOW_UP_STEP_MAX_LENGTH} characters.`
                : "One step per line. They become a checklist on a to-do card when the work is marked done."}
            </p>
            <label className="composer__checkbox thread-dependencies__handoff">
              <input checked={offerToSend && followUp.length > 0} disabled={busy || !followUp.length} type="checkbox" onChange={(event) => setOfferToSend(event.currentTarget.checked)} />
              <span>Offer to send these steps to this thread</span>
            </label>
            <button className="button button--primary" type="submit" disabled={busy || !api?.manageThreadMergeHolds || !reason.trim() || followUpTooLong}>Start Waiting</button>
          </form>
        ) : !clearing ? (
          <button className="button button--secondary" type="button" onClick={() => setCreating(true)}>Wait for Something Else…</button>
        ) : null}

        {holds.some((hold) => hold.status !== "waiting") ? (
          <>
            <button className="button button--secondary" type="button" onClick={() => setHistory(!history)}>{history ? "Hide History" : "Show History"}</button>
            {history ? holds.filter((hold) => hold.status !== "waiting").map((hold) => (
              <div className="thread-merge-holds__entry" key={hold.id}>
                <strong>{hold.status === "resolved" ? "Done" : "Stopped waiting"}: {hold.reason}</strong>
                <p>{hold.resolution?.note}</p>
                <small>{hold.resolution?.actor} · {hold.resolution ? new Date(hold.resolution.at).toLocaleString() : ""}</small>
              </div>
            )) : null}
          </>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

/** The waiting thread, stable while it stays the same thread. */
function useWaitingThread(backend: WaitingThread["backend"], threadId: string, owner: WaitingThread["owner"]): WaitingThread {
  const ownerId = owner?.scope === "remote" ? owner.instanceId : undefined;
  return useMemo(
    () => ({ backend, threadId, ...(ownerId ? { owner: { scope: "remote" as const, instanceId: ownerId } } : {}) }),
    [backend, threadId, ownerId],
  );
}
