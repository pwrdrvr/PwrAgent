import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { RESEARCH_MAX_MINUTES, RESEARCH_MAX_WORKERS, type ResearchHarnessCheck, type ResearchHarnessRequest, type ResearchHarnessStatus, type ResearchThread } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

type Operation = "import" | "discovery" | "execute";
type Capability = keyof Extract<ResearchHarnessCheck, { ok: true }>["capabilities"];

const OPERATIONS: Array<{ id: Operation; title: string; detail: string; needs: Capability[] }> = [
  { id: "import", title: "Import swarm records", detail: "Read-only. No model calls. Source work keeps running.", needs: ["import"] },
  { id: "discovery", title: "Snapshot a discovery run", detail: "Status, problems and one problem’s tree. Read-only.", needs: ["import", "discovery"] },
  { id: "execute", title: "Run a new swarm", detail: "The bridge starts it; PwrAgent supplies the model and spends its budget.", needs: ["execute", "cancel", "researchFunctions"] },
];
const CAPABILITY_LABELS: Record<Capability, string> = { import: "Import", discovery: "Discovery", execute: "Execute", cancel: "Cancel", researchFunctions: "Research functions" };
const CONFIG_SNIPPET = `[research.harness]
command = "/path/to/harness-bridge"
args = []
# For "Run a new swarm" only:
endpoint = "https://…/v1/chat/completions"
model = "…"
api_key_env = "MY_MODEL_KEY"`;

/**
 * A request ID names one exact request, so a lost reply can be retried without
 * a second admission. An unchanged retry keeps its ID; any edit takes a new one.
 */
export function harnessRequestIdentity(previous: { signature: string; id: string } | undefined, request: Omit<ResearchHarnessRequest, "requestId">, newId: () => string): { signature: string; id: string } {
  const signature = JSON.stringify(request);
  return previous?.signature === signature ? previous : { signature, id: newId() };
}

/** Why an operation cannot run on this bridge, or undefined when it can. */
function blocker(operation: Operation, status: ResearchHarnessStatus | undefined, check: ResearchHarnessCheck | undefined): string | undefined {
  if (!status?.configured) return "No bridge is configured.";
  const missing = OPERATIONS.find((entry) => entry.id === operation)!.needs.filter((need) => check?.ok && !check.capabilities[need]);
  if (missing.length) return `This bridge does not support ${missing.map((need) => CAPABILITY_LABELS[need].toLowerCase()).join(" or ")}.`;
  if (operation === "execute") {
    if (status.endpointError) return status.endpointError;
    if (!status.model || !status.endpointOrigin) return "Set an execution model and endpoint in config.toml.";
    if (status.credentialEnv && !status.credentialSet) return `${status.credentialEnv} is not set in PwrAgent’s environment.`;
  }
  return undefined;
}

export function ResearchHarnessForm({ api, thread, onStarted, onCancel }: {
  api: DesktopApi; thread: ResearchThread; onStarted: (runId: string) => void; onCancel?: () => void;
}) {
  const id = useId();
  const [status, setStatus] = useState<ResearchHarnessStatus>();
  const [check, setCheck] = useState<ResearchHarnessCheck>();
  const [checking, setChecking] = useState(false);
  const [operation, setOperation] = useState<Operation>("import");
  const [objective, setObjective] = useState("");
  const [project, setProject] = useState("");
  const [session, setSession] = useState("");
  const [swarm, setSwarm] = useState("");
  const [problem, setProblem] = useState("");
  const [workers, setWorkers] = useState(3);
  const [minutes, setMinutes] = useState(30);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const identity = useRef<{ signature: string; id: string }>(undefined);
  useEffect(() => {
    let active = true;
    void api.researchHarnessStatus?.(thread).then((result) => { if (active) setStatus(result); })
      .catch((failure: unknown) => { if (active) { setStatus({ configured: false, configError: message(failure) }); } });
    return () => { active = false; };
  }, [api, thread]);

  async function runCheck() {
    if (!api.checkResearchHarness) return;
    setChecking(true);
    try { setCheck(await api.checkResearchHarness(thread)); }
    catch (failure) { setCheck({ ok: false, checkedAt: Date.now(), error: message(failure) }); }
    finally { setChecking(false); }
  }

  const execute = operation === "execute";
  const discovery = operation === "discovery";
  const blocked = blocker(operation, status, check);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!api.startResearchHarness || busy) return;
    const title = objective.trim() || `Import ${project.trim()} / ${swarm.trim()}`;
    const request: Omit<ResearchHarnessRequest, "requestId"> = { ...thread, mode: execute ? "execute" : "import", source: discovery ? "discovery" : "swarm",
      objective: execute ? objective.trim() : title, project: project.trim(), session: discovery ? "" : session.trim(), swarm: swarm.trim(),
      ...(discovery && problem.trim() ? { problem: problem.trim() } : {}),
      // An import has no member limit or deadline: it reads what the source has, members included. Only execution binds them, as the bridge requires.
      ...(execute ? { workers, minutes } : {}), budgetAcknowledged: execute && acknowledged };
    identity.current = harnessRequestIdentity(identity.current, request, () => crypto.randomUUID());
    setBusy(true); setError("");
    try {
      const receipt = await api.startResearchHarness({ ...request, requestId: identity.current.id });
      identity.current = undefined;
      onStarted(receipt.runId);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  const caps = check?.ok ? check.capabilities : undefined;
  return <form className="research-form" aria-label="Harness research" onSubmit={(event) => { void submit(event); }}>
    <section className="research-bridge" aria-labelledby={`${id}-bridge`}>
      <div className="research-card__top">
        <h4 id={`${id}-bridge`} className="research-group">Bridge</h4>
        {status?.configured && api.checkResearchHarness && <button type="button" className="research-button" disabled={checking} onClick={() => { void runCheck(); }}>
          {checking ? "Checking…" : check ? "Check again" : "Check bridge"}</button>}
      </div>
      {!status && <p className="research-muted" role="status">Reading bridge settings…</p>}
      {status?.configError && <p className="research-error" role="alert">{status.configError}</p>}
      {status && !status.configured && !status.configError && <>
        <p className="research-text">No Harness bridge is configured in this profile. A bridge is a program you install; PwrAgent starts it and talks to it over stdio.</p>
        <pre className="research-snippet" aria-label="Example bridge configuration">{CONFIG_SNIPPET}</pre>
        <p className="research-muted"><code className="research-code">api_key_env</code> names the variable that holds the <strong>model</strong> API key. Your MathOS Platform key is the bridge’s own setting.</p>
      </>}
      {status?.configured && <dl className="research-dl">
        <dt>Process</dt><dd><code className="research-code">{status.bridge}</code>{" "}
          {check ? check.ok ? <span className="research-ok">· responding</span> : <span className="research-bad">· {check.error}</span> : <span className="research-muted">· not checked</span>}</dd>
        {caps && <><dt>Supports</dt><dd><span className="research-caps">{(Object.keys(CAPABILITY_LABELS) as Capability[]).map((key) =>
          <span key={key} className={`research-chip${caps[key] ? " research-chip--done" : " research-chip--off"}`}>{CAPABILITY_LABELS[key]}<span className="research-sr-only">{caps[key] ? " supported" : " not supported"}</span></span>)}</span></dd></>}
        {(status.model || status.endpointOrigin) && <><dt>Model</dt><dd>{status.model ? <code className="research-code">{status.model}</code> : "No model"}{status.endpointOrigin && <> at <code className="research-code">{status.endpointOrigin}</code></>}</dd></>}
        {status.credentialEnv && <><dt>Model key</dt><dd><code className="research-code">{status.credentialEnv}</code>{" "}
          {status.credentialSet ? <span className="research-ok">· set</span> : <span className="research-bad">· not set</span>}</dd></>}
        <dt>Platform sign-in</dt><dd>Held by the bridge. PwrAgent never reads it.</dd>
      </dl>}
      {status && !status.configured && api.revealResearchHarnessConfig && <span className="research-actions">
        <button type="button" className="research-button" onClick={() => { void api.revealResearchHarnessConfig?.().catch((failure: unknown) => setError(message(failure))); }}>Show config.toml</button>
      </span>}
    </section>
    {status?.configured && <>
      <fieldset className="research-ops">
        <legend className="research-sr-only">Operation</legend>
        {OPERATIONS.map((entry) => {
          const reason = blocker(entry.id, status, check);
          return <label key={entry.id} className="research-op">
            <input type="radio" name={`${id}-operation`} value={entry.id} checked={operation === entry.id} onChange={() => setOperation(entry.id)} />
            <span className="research-op__title">{entry.title}</span>
            <span className="research-op__detail">{reason ?? entry.detail}</span>
          </label>;
        })}
      </fieldset>
      {execute
        ? <label>Objective<textarea required maxLength={8000} rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What should the swarm find?" /></label>
        : null}
      <div className="research-form__row">
        <label>Project<input required maxLength={64} value={project} onChange={(e) => setProject(e.target.value)} /></label>
        {!discovery && <label>Session<input required maxLength={64} value={session} onChange={(e) => setSession(e.target.value)} /></label>}
      </div>
      <div className="research-form__row">
        <label>{discovery ? "Discovery run" : "Swarm"}<input required maxLength={64} value={swarm} onChange={(e) => setSwarm(e.target.value)} /></label>
        {discovery && <label>Problem (optional)<input maxLength={64} value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="Keeps its tree" /></label>}
      </div>
      {!execute && <label>Title (optional)<input maxLength={200} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder={project && swarm ? `Import ${project} / ${swarm}` : "Names this run here"} /></label>}
      {execute && <div className="research-form__row">
        <label>Members<input type="number" min={1} max={RESEARCH_MAX_WORKERS} required value={workers} onChange={(e) => setWorkers(Number(e.target.value))} /></label>
        <label>Deadline (minutes)<input type="number" min={1} max={RESEARCH_MAX_MINUTES} required value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
      </div>}
      <dl className="research-dl">
        <dt>Evidence opens from</dt>
        <dd>{status.workspace ? <code className="research-code">{status.workspace}</code> : <span className="research-bad">This thread has no directory. Link one first; evidence opens only from it.</span>}</dd>
      </dl>
      {execute && <div className="research-budget" role="group" aria-label="Model budget">
        <span className="research-group">Spends model budget</span>
        <ul>
          <li>Two compatibility calls before anything starts</li>
          <li>Calls until the deadline or Stop</li>
          <li>No hard spend cap; tokens and dollars are unknown</li>
          <li>A call in flight at Stop may still bill</li>
        </ul>
        <label className="research-check"><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I accept spending model budget without a cap.</label>
      </div>}
      {!execute && <p className="research-muted">{discovery ? "Source scores and verification are kept as reported. PwrAgent has not verified them." : "Source verdicts are kept as observations. Accepting a candidate here is your own review."}</p>}
      {error && <p role="alert" className="research-error">{error}</p>}
      {error && execute && <p className="research-muted">Submitting this unchanged request again reuses its request ID, so it cannot start a second swarm.</p>}
    </>}
    <div className="research-actions">
      {status?.configured && <button type="submit" className="research-button research-button--primary"
        disabled={busy || Boolean(blocked) || !status.workspace || (execute && !acknowledged)}>{execute ? "Start swarm" : discovery ? "Take snapshot" : "Import records"}</button>}
      {onCancel && <button type="button" className="research-button research-button--ghost" onClick={onCancel}>Cancel</button>}
    </div>
  </form>;
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : "The Harness request failed";
  // Electron prefixes remote handler errors with the channel; the owner's sentence is the useful part.
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
