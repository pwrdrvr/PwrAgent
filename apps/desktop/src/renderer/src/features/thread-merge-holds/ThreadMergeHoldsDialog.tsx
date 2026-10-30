import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { parseThreadUrl, type ManageThreadMergeHoldsRequest, type NavigationThreadSummary, type ThreadMergeHold } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { useModalDialog } from "../../lib/useModalDialog";
import { useThreadLinks } from "../../lib/thread-links";
import { ThreadChip } from "../thread-detail/ThreadChip";
import { useThreadMergeHolds } from "./useThreadMergeHolds";

export function ThreadMergeHoldsDialog({ thread, api, onClose }: { thread: NavigationThreadSummary; api?: DesktopApi; onClose: () => void }) {
  const target = thread.federation?.ref.target ?? readRendererFederationTarget();
  const { data, error: readError, refresh } = useThreadMergeHolds(thread.source, thread.id, target, api);
  const [reason, setReason] = useState("");
  const [releaseWhen, setReleaseWhen] = useState("");
  const [dependencyUrl, setDependencyUrl] = useState("");
  const [note, setNote] = useState("");
  const [clearing, setClearing] = useState<{ hold: ThreadMergeHold; owner?: ManageThreadMergeHoldsRequest["federationTarget"] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState(false);
  const [creating, setCreating] = useState(false);
  const titleId = useId();
  const ref = useModalDialog<HTMLElement>({ onClose: () => { if (!busy) onClose(); }, initialFocus: "dialog" });
  const links = useThreadLinks();
  const response = data;
  const holds = response?.holds ?? thread.mergeHolds ?? [];
  const active = holds.filter((hold) => hold.status === "waiting");
  const dependency = dependencyUrl.trim() ? parseThreadUrl(dependencyUrl.trim()) : undefined;

  const submit = async (request: ManageThreadMergeHoldsRequest) => {
    if (!api?.manageThreadMergeHolds) return;
    setBusy(true); setError(undefined);
    try {
      await api.manageThreadMergeHolds(request);
      refresh();
      setCreating(false); setReason(""); setReleaseWhen(""); setDependencyUrl(""); setNote(""); setClearing(undefined);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };

  const dependencyLink = (hold: ThreadMergeHold) => {
    const dependency = hold.dependency;
    if (!dependency) return null;
    const instanceId = dependency.target.scope === "remote" ? dependency.target.instanceId : target?.scope === "remote" ? target.instanceId : undefined;
    const link = links?.resolve({ backend: dependency.backend, threadId: dependency.threadId, ...(instanceId ? { instanceId } : {}) })
      ?? { backend: dependency.backend, threadId: dependency.threadId, title: dependency.title ?? dependency.threadId, ...(instanceId ? { instanceId } : {}) };
    return <ThreadChip link={link} fallbackLabel={dependency.title} onOpen={(value) => links?.show(value)} />;
  };

  return createPortal(<div className="rename-thread-backdrop" role="presentation">
    <section className="rename-thread-dialog thread-merge-holds" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="thread-merge-holds__header"><h2 id={titleId}>Merge holds</h2><button className="button button--secondary" type="button" disabled={busy} onClick={onClose}>Done</button></header>
      <p className="thread-dependencies__hint">{thread.title || "This thread"} can keep working. Merging waits until every hold is explicitly cleared.</p>
      {error || readError ? <p role="alert">{error ?? readError}</p> : null}
      {active.filter((hold) => hold.id !== clearing?.hold.id).map((hold) => <div className="thread-merge-holds__entry" key={hold.id}>
        <strong>Merge held — {hold.reason}</strong>
        {dependencyLink(hold)}
        <p>Release when: {hold.releaseWhen}</p>
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => { setClearing({ hold, owner: target }); setNote(""); }}>Resolve hold…</button>
      </div>)}
      {response?.dependents.map(({ hold, owner }) => <div className="thread-merge-holds__entry" key={`${owner?.scope === "remote" ? owner.instanceId : "local"}:${hold.id}`}>
        <strong>Waiting on this work</strong>
        <ThreadChip link={links?.resolve({ backend: hold.backend, threadId: hold.threadId, ...(owner?.scope === "remote" ? { instanceId: owner.instanceId } : {}) })
          ?? { backend: hold.backend, threadId: hold.threadId, title: hold.reason, ...(owner?.scope === "remote" ? { instanceId: owner.instanceId } : {}) }} onOpen={(value) => links?.show(value)} />
        <p>{hold.reason}</p><p>Release when: {hold.releaseWhen}</p>
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => { setClearing({ hold, owner }); setNote(""); }}>Report completion…</button>
      </div>)}
      {response?.unavailablePeers?.length ? <p className="thread-dependencies__hint">Could not check waiting threads on: {response.unavailablePeers.join(", ")}.</p> : null}
      {clearing ? <div className="thread-merge-holds__entry thread-dependencies__form">
        <strong>{clearing.hold.reason}</strong><p>Release when: {clearing.hold.releaseWhen}</p>
        <label className="thread-dependencies__field"><span>Findings or reason for clearing</span><textarea rows={3} maxLength={2000} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} /></label>
        <div className="thread-merge-holds__actions">
          <button className="button button--primary" type="button" disabled={busy || !note.trim()} onClick={() => void submit({ action: "resolve", backend: clearing.hold.backend, threadId: clearing.hold.threadId, federationTarget: clearing.owner, holdId: clearing.hold.id, note })}>Resolve hold</button>
          <button className="button button--secondary" type="button" disabled={busy || !note.trim()} onClick={() => void submit({ action: "cancel", backend: clearing.hold.backend, threadId: clearing.hold.threadId, federationTarget: clearing.owner, holdId: clearing.hold.id, note })}>Remove prerequisite</button>
          <button className="button button--secondary" type="button" disabled={busy} onClick={() => setClearing(undefined)}>Keep waiting</button>
        </div>
      </div> : null}
      {!clearing && (creating || (!active.length && !response?.dependents.length)) ? <form className="thread-dependencies__form" onSubmit={(event) => { event.preventDefault(); if (dependencyUrl.trim() && !dependency) { setError("Paste a PwrAgent thread link, or leave the dependency blank."); return; }
        void submit({ action: "create", backend: thread.source, threadId: thread.id, federationTarget: target, reason, releaseWhen,
          ...(dependency ? { dependency: { backend: dependency.backend ?? thread.source, threadId: dependency.threadId,
            target: dependency.instanceId ? { scope: "remote", instanceId: dependency.instanceId } : { scope: "local" },
            title: links?.resolve(dependency)?.title,
          } } : {}),
        });
      }}>
        <label className="thread-dependencies__field"><span>Hold merge because</span><textarea required rows={2} maxLength={2000} disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Waiting for Windows validation" /></label>
        <label className="thread-dependencies__field"><span>Release when</span><textarea required rows={2} maxLength={2000} disabled={busy} value={releaseWhen} onChange={(event) => setReleaseWhen(event.target.value)} placeholder="The investigation findings have been reconciled with this PR" /></label>
        <label className="thread-dependencies__field"><span>Waiting on (optional thread link)</span><input className="thread-dependencies__search" disabled={busy} value={dependencyUrl} onChange={(event) => setDependencyUrl(event.target.value)} placeholder="pwragent://thread/…" /></label>
        <button className="button button--primary" type="submit" disabled={busy || !api?.manageThreadMergeHolds || !reason.trim() || !releaseWhen.trim()}>Hold merge</button>
      </form> : !clearing ? <button className="button button--secondary" type="button" onClick={() => setCreating(true)}>Add hold…</button> : null}
      {holds.some((hold) => hold.status !== "waiting") ? <><button className="button button--secondary" type="button" onClick={() => setHistory(!history)}>{history ? "Hide history" : "Show history"}</button>{history ? holds.filter((hold) => hold.status !== "waiting").map((hold) => <div className="thread-merge-holds__entry" key={hold.id}><strong>{hold.status === "resolved" ? "Resolved" : "Removed"}: {hold.reason}</strong><p>{hold.resolution?.note}</p><small>{hold.resolution?.actor} · {hold.resolution ? new Date(hold.resolution.at).toLocaleString() : ""}</small></div>) : null}</> : null}
    </section>
  </div>, document.body);
}
