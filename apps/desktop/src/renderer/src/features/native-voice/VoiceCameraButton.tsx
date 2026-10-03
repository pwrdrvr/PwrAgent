import { useEffect, useRef, useState } from "react";
import { CAMERA_REACTIONS } from "../../../../shared/native-voice-camera";
import type { NativeVoiceController, VoiceView } from "./native-voice-controller";

type CameraProps = { controller: NativeVoiceController; view: VoiceView };

export function VoiceCameraButton({ controller, view }: CameraProps) {
  if (view.status !== "listening") return null;
  const active = Boolean(view.camera);
  const label = active ? "Turn off camera cues" : "Turn on camera cues";
  return (
    <button
      type="button"
      className={`sidebar__icon-button${active ? " is-active" : ""}`}
      aria-label={label}
      aria-pressed={active}
      title={`${label}. Frames stay on this machine. Voice ends after 30 seconds away.`}
      onClick={() => { void controller.setCamera(!active); }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="6" width="13" height="12" rx="2" />
        <path d="m16 10 5-3v10l-5-3" />
      </svg>
    </button>
  );
}

const percent = (value?: number) => value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;

/** Preview and memory-only receipts belong to the conversation, below its transcript. */
export function VoiceCameraPanel({ controller, view }: CameraProps) {
  const panel = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(Date.now);
  const active = Boolean(view.camera) && view.status === "listening";
  const debug = view.cameraDiagnostics;
  const hasDebug = debug !== undefined;
  useEffect(() => {
    if (!active && !hasDebug) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, hasDebug]);
  useEffect(() => {
    const element = video.current;
    if (!element || !active || view.camera !== "on") return;
    panel.current?.scrollIntoView?.({ block: "nearest" });
    element.srcObject = controller.cameraStream() ?? null;
    void element.play().catch(() => undefined);
    return () => { element.srcObject = null; };
  }, [controller, view.camera, active]);
  if (!active && !view.cameraError && !debug) return null;
  const observation = debug?.observation;
  const age = debug?.lastObservedAt === undefined ? undefined : Math.max(0, now - debug.lastObservedAt);
  const rate = active && age !== undefined && age < 10_000 ? debug?.rateHz ?? 0 : 0;
  const delivery = debug?.delivery === "acknowledged"
    ? `Voice context acknowledged · ${debug.lastCue}`
    : debug?.delivery === "pending" ? active ? "Sending context to voice…" : "Voice context delivery unconfirmed after camera stopped"
      : debug?.delivery === "failed" ? "Voice context delivery failed"
        : "No voice context sent yet";
  return (
    <section ref={panel} className="voice-camera__panel" aria-label="Camera cues">
      {active && view.camera === "on" ? <video ref={video} muted playsInline autoPlay className="voice-camera__preview" /> : null}
      <span className="voice-camera__status" role={view.cameraError ? "alert" : "status"}>
        {view.cameraError ?? (!active ? "Camera off" : view.camera === "starting" ? "Starting camera…"
          : view.cameraWarming ? "Camera cues · warming up…" : debug?.filter.startsWith("Stale") ? "Camera cues · waiting for a fresh frame" : "Camera cues · receiving observations")}
      </span>
      {view.cameraError ? <button type="button" className="button button--ghost" onClick={() => controller.dismissCameraError()}>Dismiss</button> : null}
      <span className="voice-camera__hint">{view.cameraWarming ? "Model loading can take a few minutes. One request at a time." : delivery}</span>
      {active ? <span className="voice-camera__hint">Local analysis · ends voice after 30s of confident absence</span> : null}
      {debug ? (
        <details className="voice-camera__debug">
          <summary>Camera diagnostics · {debug.observations} results · {rate.toFixed(2)} Hz</summary>
          <dl>
            <dt>Latest result</dt><dd>{age === undefined ? "Waiting" : `${(age / 1000).toFixed(1)}s ago`}</dd>
            <dt>Model / frame age</dt><dd>{observation ? `${observation.latencyMs.toFixed(0)} / ${debug.frameAgeMs?.toFixed(0) ?? "—"} ms` : "—"}</dd>
            <dt>Stale results discarded</dt><dd>{debug.staleObservations}</dd>
            <dt>Filter</dt><dd>{debug.filter}</dd>
            <dt>Voice context</dt><dd>{delivery} · {debug.cuesAcknowledged} acknowledgments</dd>
            <dt>Last acknowledgment</dt><dd>{debug.acknowledgedAt === undefined ? "—" : new Date(debug.acknowledgedAt).toLocaleTimeString()}</dd>
            <dt>Thread</dt><dd>{debug.threadId}</dd>
            <dt>Session</dt><dd>{debug.sessionId}</dd>
          </dl>
          <table aria-label="Clef confidence scores">
            <thead><tr><th>Cue</th><th>Confidence</th></tr></thead>
            <tbody>
              {(["present", "away"] as const).map((cue) => <tr key={cue}><td>{cue}{observation && (cue === "present") === observation.present ? " · selected" : ""}</td><td>{percent(observation?.presenceScores?.[cue] ?? (observation && (cue === "present") === observation.present ? observation.presenceConfidence : undefined))}</td></tr>)}
              {CAMERA_REACTIONS.map((cue) => <tr key={cue}><td>{cue}{observation?.reaction === cue ? " · selected" : ""}</td><td>{percent(observation?.reactionScores?.[cue] ?? (observation?.reaction === cue ? observation.reactionConfidence : undefined))}</td></tr>)}
            </tbody>
          </table>
          <p>Rate measures completed decisions over the last 10s. Context acknowledgment confirms the appendText RPC; it does not prove the model used the cue.</p>
          {debug.error ? <p className="voice-camera__debug-error">{debug.error}</p> : null}
        </details>
      ) : null}
    </section>
  );
}
