import { useEffect, useState, type FormEvent } from "react";
import type { ResearchThread, ResearchHarnessStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

export function ResearchHarnessForm({ api, thread, onStarted }: { api: DesktopApi; thread: ResearchThread; onStarted: () => void }) {
  const [configuration, setConfiguration] = useState<ResearchHarnessStatus>({ configured: false });
  const [mode, setMode] = useState<"import" | "execute">("import");
  const [objective, setObjective] = useState("");
  const [project, setProject] = useState("");
  const [session, setSession] = useState("");
  const [swarm, setSwarm] = useState("");
  const [workers, setWorkers] = useState(3);
  const [minutes, setMinutes] = useState(30);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let active = true;
    void api.researchHarnessStatus?.().then((result) => { if (active) setConfiguration(result); }).catch(() => { if (active) setError("Harness settings could not be read."); });
    return () => { active = false; };
  }, [api]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!api.startResearchHarness || !acknowledged) return;
    setBusy(true); setError("");
    try {
      await api.startResearchHarness({ ...thread, requestId, mode, objective, project, session, swarm, workers, minutes, budgetAcknowledged: true });
      onStarted();
    } catch { setError("The request outcome could not be confirmed. Inspect retained runs before starting another request. Repeating this unchanged request uses the same identity."); }
    finally { setBusy(false); }
  }
  return <form className="research-form" aria-label="Harness research" onSubmit={(event) => { void submit(event); }}>
    <div className="research-switch" role="group" aria-label="Harness operation">
      <button type="button" aria-pressed={mode === "import"} onClick={() => setMode("import")}>Import records</button>
      <button type="button" aria-pressed={mode === "execute"} onClick={() => setMode("execute")}>Execute</button>
    </div>
    {!configuration.configured && <p className="research-muted">Configure a trusted Harness process bridge in this profile’s settings file to enable this operation.</p>}
    {mode === "execute" && <p className="research-muted">Execution model: {configuration.model ?? "not configured"} · endpoint: {configuration.endpointOrigin ?? "not configured or invalid"}. This model must pass the compatibility probe before execution.</p>}
    <label>Objective<textarea required maxLength={8000} rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} /></label>
    <label>Harness project<input required maxLength={64} value={project} onChange={(e) => setProject(e.target.value)} /></label>
    <label>Harness session<input required maxLength={64} value={session} onChange={(e) => setSession(e.target.value)} /></label>
    <label>Swarm ID<input required maxLength={64} value={swarm} onChange={(e) => setSwarm(e.target.value)} /></label>
    <label>Member limit<input type="number" min={1} max={8} required value={workers} onChange={(e) => setWorkers(Number(e.target.value))} /></label>
    <label>Deadline in minutes<input type="number" min={1} max={120} required value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
    <p className="research-muted">Evidence is restricted to this thread’s current workspace, which must be the source project’s mounted workspace. Source verdicts do not accept or verify a candidate in PwrAgent.</p>
    <p className="research-muted">{mode === "execute" ? "Execution spends model budget. Compatibility probing makes two model calls. The owner fences model calls at the deadline and requests scoped cancellation; remote stop must be acknowledged." : "Import observes an existing swarm. It does not start or stop source work."} Token and dollar usage may be unknown. There is no hard spend cap, and in-flight calls may bill after cancellation.</p>
    <label><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I acknowledge the workspace and budget scope.</label>
    {error && <p role="alert" className="research-error">{error}</p>}
    <button type="submit" className="research-button research-button--primary" disabled={busy || !configuration.configured || !acknowledged || (mode === "execute" && (!configuration.model || !configuration.endpointOrigin))}>{mode === "execute" ? "Start Harness execution" : "Import Harness records"}</button>
  </form>;
}
