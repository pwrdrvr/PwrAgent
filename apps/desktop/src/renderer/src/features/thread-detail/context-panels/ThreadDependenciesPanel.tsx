import { useEffect, useRef, useState } from "react";
import type { NavigationThreadSummary, ThreadDependency, ThreadDependencyCondition } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { Select } from "../../../components/Select";
import { readRendererFederationTarget } from "../../../lib/federation-window";

const CONDITIONS = [
  { value: "turn_completed", label: "Turn completes" },
  { value: "pr_attached", label: "Reviewable PR is attached" },
  { value: "ci_passed", label: "PR passes CI" },
  { value: "pr_merged", label: "PR is merged" },
] as const;

export function ThreadDependenciesPanel({ thread, desktopApi }: { thread: NavigationThreadSummary; desktopApi?: DesktopApi }) {
  const [dependencies, setDependencies] = useState<ThreadDependency[]>([]);
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<NavigationThreadSummary[]>([]);
  const [targetKey, setTargetKey] = useState("");
  const [when, setWhen] = useState<ThreadDependencyCondition["when"]>("ci_passed");
  const [prUrl, setPrUrl] = useState("");
  const [conditions, setConditions] = useState<ThreadDependencyCondition[]>([]);
  const [mode, setMode] = useState<"all" | "any">("all");
  const [onFailure, setOnFailure] = useState<"notify" | "wait">("wait");
  const [continuation, setContinuation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const key = JSON.stringify([thread.source, thread.id]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const remote = (thread.federation?.ref.target ?? readRendererFederationTarget())?.scope === "remote";
  const available = Boolean(desktopApi?.manageThreadDependencies) && !remote;

  useEffect(() => {
    let disposed = false;
    setDependencies([]); setOpen(false); setConditions([]); setTargets([]);
    setTargetKey(""); setError(undefined); setBusy(false); setContinuation(""); setPrUrl("");
    const refresh = async () => {
      if (!available) return;
      try {
        const response = await desktopApi!.manageThreadDependencies!({ action: "list", backend: thread.source, threadId: thread.id });
        if (!disposed) setDependencies(response.dependencies);
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void refresh();
    const unsubscribe = desktopApi?.onAgentEvent?.((event) => {
      if (event.federationTarget?.scope !== "remote" && event.backend === thread.source
        && event.notification.method === "thread/dependencies/updated" && event.notification.params.threadId === thread.id) void refresh();
    });
    return () => { disposed = true; unsubscribe?.(); };
  }, [available, desktopApi, thread.source, thread.id]);

  const loadTargets = async () => {
    setOpen(true); setBusy(true); setError(undefined);
    try {
      const snapshot = await desktopApi?.getNavigationSnapshot?.();
      if (currentKey.current !== key) return;
      setTargets((snapshot?.threads ?? []).filter((candidate) => candidate.federation?.ref.target.scope !== "remote"
        && (candidate.id !== thread.id || candidate.source !== thread.source)));
    } catch (reason) {
      if (currentKey.current === key) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (currentKey.current === key) setBusy(false);
    }
  };

  const selected = targets.find((target) => JSON.stringify([target.source, target.id]) === targetKey);
  const selectedCondition: ThreadDependencyCondition | undefined = selected ? {
    backend: selected.source, threadId: selected.id, when,
    ...(when !== "turn_completed" && prUrl.trim() ? { prUrl: prUrl.trim() } : {}),
  } : undefined;

  const submit = async (action: "create" | "cancel" | "dismiss", dependencyId?: string) => {
    setBusy(true); setError(undefined);
    try {
      const response = await desktopApi!.manageThreadDependencies!({
        action, backend: thread.source, threadId: thread.id,
        ...(action === "create" ? {
          conditions: conditions.length ? conditions : selectedCondition ? [selectedCondition] : [],
          mode, onFailure, ...(continuation.trim() ? { continuation: continuation.trim() } : {}),
        } : { dependencyId }),
      });
      if (currentKey.current !== key) return;
      setDependencies(response.dependencies);
      if (action === "create") { setOpen(false); setConditions([]); }
    } catch (reason) {
      if (currentKey.current === key) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (currentKey.current === key) setBusy(false);
    }
  };

  const titleFor = (condition: ThreadDependencyCondition) => targets.find((target) => target.source === condition.backend && target.id === condition.threadId)?.title ?? condition.threadId;

  return (
    <section className="context-panel__section thread-dependencies">
      <h3>Continue after</h3>
      {remote ? <p className="context-list__meta">Dependencies are available for local threads.</p> : null}
      {dependencies.map((dependency) => (
        <div className="context-list__item" key={dependency.id}>
          <div className="context-list__content">
            <p className="context-list__label">{dependency.status === "dispatching" ? dependency.error ? "Delivery needs review" : "Continuing" : dependency.status === "delivered" ? dependency.outcome === "failure" ? "Prerequisite failed" : "Continued" : dependency.status === "ready" ? "Ready to continue" : dependency.status === "cancelled" ? "Cancelled" : dependency.status === "dismissed" ? "Dismissed" : "Waiting"}</p>
            {dependency.evidence.length ? dependency.evidence.map((entry, index) => (
              <p className="context-list__meta" key={index}>{titleFor(entry.condition)} · {entry.reason}{entry.headSha ? ` · ${entry.headSha.slice(0, 8)}` : ""}</p>
            )) : dependency.conditions.map((condition, index) => <p className="context-list__meta" key={index}>{titleFor(condition)} · {CONDITIONS.find((entry) => entry.value === condition.when)?.label}</p>)}
            {dependency.error ? <p className="context-list__meta" role="status">{dependency.error}</p> : null}
          </div>
          {dependency.status === "waiting" || dependency.status === "ready" ? <button className="context-list__action" type="button" disabled={busy} onClick={() => void submit("cancel", dependency.id)}>Cancel</button> : null}
          {dependency.status === "dispatching" && dependency.error ? <button className="context-list__action" type="button" disabled={busy} onClick={() => void submit("dismiss", dependency.id)}>Dismiss after review</button> : null}
        </div>
      ))}
      {!open ? <button className="context-list__action" type="button" disabled={!available || busy} onClick={() => void loadTargets()}>Continue after…</button> : (
        <form className="thread-dependencies__form" onSubmit={(event) => { event.preventDefault(); void submit("create"); }}>
          <label>Prerequisite thread
            <Select value={targetKey} onChange={setTargetKey} disabled={busy} options={[
              { value: "", label: "Choose a thread" },
              ...targets.map((target) => ({ value: JSON.stringify([target.source, target.id]), label: `${target.title ?? target.id} · ${target.source}` })),
            ]} />
          </label>
          <label>Continue when
            <Select value={when} onChange={setWhen} disabled={busy} options={[...CONDITIONS]} />
          </label>
          {when !== "turn_completed" ? <label>PR URL (optional)
            <input value={prUrl} onChange={(event) => setPrUrl(event.target.value)} disabled={busy} placeholder="Required if the thread has several PRs" />
          </label> : null}
          <p className="context-list__meta">{when === "turn_completed" ? "Watches the current or latest turn. A completed turn may still have pending CI." : "The PR may be attached later. CI follows its current head."}</p>
          {conditions.map((condition, index) => <div className="context-list__item" key={index}>
            <span className="context-list__meta">{titleFor(condition)} · {CONDITIONS.find((entry) => entry.value === condition.when)?.label}</span>
            <button type="button" className="context-list__action" disabled={busy} aria-label={`Remove prerequisite ${index + 1}`} onClick={() => setConditions(conditions.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
          </div>)}
          <button type="button" className="context-list__action" disabled={busy || !selectedCondition || conditions.length >= 16} onClick={() => {
            if (selectedCondition) { setConditions([...conditions, selectedCondition]); setTargetKey(""); setPrUrl(""); }
          }}>Add prerequisite</button>
          {conditions.length > 1 ? <label>Prerequisites
            <Select value={mode} onChange={setMode} disabled={busy} options={[{ value: "all", label: "Wait for all" }, { value: "any", label: "Wait for any" }]} />
          </label> : null}
          <label>If CI fails
            <Select value={onFailure} onChange={setOnFailure} disabled={busy} options={[{ value: "wait", label: "Wait through repairs" }, { value: "notify", label: "Resume to report the failure" }]} />
          </label>
          <label>Continuation (optional)
            <textarea value={continuation} onChange={(event) => setContinuation(event.target.value)} disabled={busy} maxLength={8000} placeholder="Continue the previously requested work" />
          </label>
          <div className="thread-dependencies__actions">
            <button className="context-list__action" type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
            <button className="context-list__action" type="submit" disabled={busy || (!conditions.length && !selectedCondition)}>Save dependency</button>
          </div>
        </form>
      )}
      {error ? <p className="context-list__meta" role="alert">{error}</p> : null}
    </section>
  );
}
