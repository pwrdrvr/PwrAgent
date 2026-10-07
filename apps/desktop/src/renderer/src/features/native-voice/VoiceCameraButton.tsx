import { useEffect, useRef, useState } from "react";
import {
  CAMERA_GESTURES,
  CAMERA_VIBES,
  type CameraCue,
  type CameraGesture,
  type VoiceCameraObservation,
} from "../../../../shared/native-voice-camera";
import { CopyIcon } from "../../icons";
import { tooltipHandlers, useViewportTooltip } from "../../lib/useViewportTooltip";
import type { NativeVoiceController, VoiceCameraDiagnostics, VoiceView } from "./native-voice-controller";

type CameraProps = { controller: NativeVoiceController; view: VoiceView };

/** The camera mark, shared by the header toggle and the transcript's cue receipts. */
export function CameraGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
    </svg>
  );
}

type TooltipProps = {
  /** A floating host passes its own layer: the tooltip portals out of it. */
  tooltipClassName?: string;
};

const cameraHint = (active: boolean) => `${active ? "Turn off camera cues" : "Turn on camera cues"}. Frames stay on this machine. Voice ends after 30 seconds away.`;

export function VoiceCameraButton({ controller, tooltipClassName = "viewport-tooltip", view }: CameraProps & TooltipProps) {
  const tooltip = useViewportTooltip({ className: tooltipClassName });
  const active = Boolean(view.camera);
  // No decision model that reads camera cues: the camera is not a feature here.
  if (view.status !== "listening" || (!active && !view.cameraOffered)) return null;
  return (
    <>
      <button
        type="button"
        className={`sidebar__icon-button${active ? " is-active" : ""}`}
        aria-label={active ? "Turn off camera cues" : "Turn on camera cues"}
        aria-pressed={active}
        aria-describedby={tooltip.visible ? tooltip.tooltipId : undefined}
        {...tooltipHandlers(tooltip, cameraHint(active))}
        onClick={(event) => {
          void controller.setCamera(!active);
          // The open hint describes the state just left; show the new one.
          tooltip.show(event.currentTarget, cameraHint(!active));
        }}
      >
        <CameraGlyph size={16} />
      </button>
      {tooltip.tooltipNode}
    </>
  );
}

const GESTURE_LABELS: Record<CameraGesture, string> = {
  pointing: "pointing",
  ok: "ok",
  stop: "stop",
  thumbs_up: "thumbs up",
  double_thumbs_up: "two thumbs up",
  thumbs_down: "thumbs down",
  face_palm: "face palm",
  none: "none",
};

const isGesture = (value: string): value is CameraGesture => CAMERA_GESTURES.some((gesture) => gesture === value);

/** A cue as the operator would say it: "thumbs up", not `thumbs_up`. */
export function cameraCueLabel(cue: CameraCue): string {
  return isGesture(cue) ? GESTURE_LABELS[cue] : cue;
}

type Question = "gesture" | "vibe" | "present";

function questionFor(cue: CameraCue): Question {
  if (cue === "away") return "present";
  return isGesture(cue) ? "gesture" : "vibe";
}

/** How long the row that produced a sent cue keeps its glow and "sent" pill. */
const SENT_HIGHLIGHT_MS = 4_000;

type Reading = { question: Question; pick: string; confidence?: number; idle: boolean };

function readings(observation: VoiceCameraObservation): Reading[] {
  const gesture = observation.gesture;
  return [
    {
      question: "gesture",
      pick: gesture ? GESTURE_LABELS[gesture] : "none",
      confidence: gesture ? observation.gestureConfidence ?? observation.gestureScores?.[gesture] : undefined,
      idle: !gesture || gesture === "none",
    },
    {
      question: "vibe",
      pick: observation.reaction,
      confidence: observation.reactionConfidence,
      idle: observation.reaction === "neutral",
    },
    {
      question: "present",
      pick: observation.present ? "yes" : "no",
      confidence: observation.presenceConfidence,
      idle: false,
    },
  ];
}

type ScoreCard = { question: Question; type: "choice" | "noul"; pick: string; options: { label: string; score?: number; selected: boolean }[] };

function scoreCards(observation: VoiceCameraObservation): ScoreCard[] {
  const presence = (present: boolean) => observation.presenceScores?.[present ? "present" : "away"]
    ?? (observation.present === present ? observation.presenceConfidence : undefined);
  return [
    {
      question: "gesture",
      type: "choice",
      pick: GESTURE_LABELS[observation.gesture ?? "none"],
      options: CAMERA_GESTURES.map((gesture) => ({
        label: GESTURE_LABELS[gesture],
        score: observation.gestureScores?.[gesture],
        selected: (observation.gesture ?? "none") === gesture,
      })),
    },
    {
      question: "vibe",
      type: "choice",
      pick: observation.reaction,
      options: CAMERA_VIBES.map((vibe) => ({
        label: vibe,
        score: observation.reactionScores?.[vibe] ?? (observation.reaction === vibe ? observation.reactionConfidence : undefined),
        selected: observation.reaction === vibe,
      })),
    },
    {
      question: "present",
      type: "noul",
      pick: observation.present ? "yes" : "no",
      options: [
        { label: "yes", score: presence(true), selected: observation.present },
        { label: "no", score: presence(false), selected: !observation.present },
      ],
    },
  ];
}

const percent = (value?: number) => value === undefined ? "—" : `${Math.round(value * 100)}%`;
const barWidth = (value?: number) => `${Math.max(0, Math.min(1, value ?? 0)) * 100}%`;

/** Everything the dock leaves off-screen, for a bug report. */
export function cameraDiagnosticsText(debug: VoiceCameraDiagnostics, now = Date.now()): string {
  const observation = debug.observation;
  const scores = observation
    ? scoreCards(observation).map((card) => `${card.question}: ${card.options.map((option) => `${option.label} ${percent(option.score)}`).join(", ")}`)
    : [];
  return [
    "Camera diagnostics",
    `Results: ${debug.observations} (${debug.rateHz.toFixed(2)}/s), stale discarded: ${debug.staleObservations}, skipped: ${debug.skippedFrames ?? 0}${debug.skipped ? ` (${debug.skipped}${debug.inFlight ? `, ${debug.inFlight} in flight` : ""})` : ""}`,
    `Latest result: ${debug.lastObservedAt === undefined ? "waiting" : `${((now - debug.lastObservedAt) / 1000).toFixed(1)}s ago`}`,
    `Model / frame age: ${observation ? `${observation.latencyMs.toFixed(0)} / ${debug.frameAgeMs?.toFixed(0) ?? "—"} ms` : "—"}`,
    `Filter: ${debug.filter}`,
    `Voice context: ${debug.delivery ?? "none sent"}${debug.lastCue ? ` (${debug.lastCue})` : ""}, ${debug.cuesAcknowledged} acknowledged`,
    `Thread: ${debug.threadId}`,
    `Session: ${debug.sessionId}`,
    ...scores,
    ...(debug.error ? [`Error: ${debug.error}`] : []),
  ].join("\n");
}

/**
 * The camera, fixed between the transcript and the message field. The
 * video, the classifier's live reading, and the model's speed are state,
 * so they hold one place for the whole session; the cues it sends are
 * moments, and those go in the transcript. The accent marks a real pick,
 * so an idle "none" or "neutral" stays quiet and a gesture reads in a
 * recording without narration.
 *
 * The panel's width picks the layout, through a container query: at the
 * default width the tile sits beside each question's top pick; dragged
 * wider, the video spans the dock with every option's meter below it. Both
 * readouts render and CSS shows one, so a resize never remounts the video.
 */
export function VoiceCameraDock({ controller, onCopyDiagnostics, tooltipClassName = "viewport-tooltip", view }: CameraProps & TooltipProps & {
  onCopyDiagnostics?: (text: string) => void;
}) {
  const tooltip = useViewportTooltip({ className: tooltipClassName });
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(Date.now);
  const active = Boolean(view.camera) && view.status === "listening";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    const element = video.current;
    if (!element || !active || view.camera !== "on") return;
    element.srcObject = controller.cameraStream() ?? null;
    void element.play().catch(() => undefined);
    return () => { element.srcObject = null; };
  }, [controller, view.camera, active]);
  if (!active && !view.cameraError) return null;

  const debug = view.cameraDiagnostics;
  // While Clef skips frames the last result is not a live reading, so it is
  // not shown as one; the preview stays up.
  const skipped = active && view.camera === "on" && !view.cameraWarming ? debug?.skipped : undefined;
  const observation = active && !view.cameraWarming && !skipped ? debug?.observation : undefined;
  const age = debug?.lastObservedAt === undefined ? undefined : Math.max(0, now - debug.lastObservedAt);
  const fresh = age !== undefined && age < 10_000;
  const stale = Boolean(debug?.filter.startsWith("Stale"));
  const rate = fresh ? debug?.rateHz ?? 0 : 0;
  const sent = debug?.delivery === "acknowledged" && debug.lastCue && debug.acknowledgedAt !== undefined
    && now - debug.acknowledgedAt < SENT_HIGHLIGHT_MS
    ? questionFor(debug.lastCue)
    : undefined;
  const status = !active ? "Camera off"
    : view.camera === "starting" ? "Starting camera…"
      : view.cameraWarming ? "Camera cues warming up. Model loading can take a few minutes."
        : skipped ? `Camera cues paused: the cue model is ${skipped === "busy" ? "busy" : "unavailable"}. Retrying.`
          : stale ? "Camera cues waiting for a fresh frame"
            : "Camera cues receiving observations";
  const live = active && view.camera === "on" && !view.cameraWarming && observation !== undefined;
  const placeholders = (["gesture", "vibe", "present"] as const);

  return (
    <section className="voice-camera-dock" aria-label="Camera cues">
      <div className="voice-camera-dock__bar">
        <span className="voice-camera-dock__eyebrow">Camera cues</span>
        <span className="voice-camera-dock__tag">clef · local</span>
        <span className="voice-camera-dock__stats">
          {live && observation ? (
            <>
              <span><b>{observation.latencyMs.toFixed(0)}</b> ms</span>
              <span><b>{rate.toFixed(1)}</b> /s</span>
            </>
          ) : active ? <span>{view.camera === "starting" ? "starting" : view.cameraWarming ? "warming up" : skipped === "busy" && debug?.inFlight ? `busy · ${debug.inFlight} in flight` : skipped ?? "waiting"}</span> : null}
        </span>
        {debug && onCopyDiagnostics ? (
          <button
            className="app-notice-toast__icon-button"
            type="button"
            aria-label="Copy camera diagnostics"
            {...tooltipHandlers(tooltip, "Copy camera diagnostics")}
            onClick={() => onCopyDiagnostics(cameraDiagnosticsText(debug, now))}
          >
            <CopyIcon size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {tooltip.tooltipNode}
      <span className="voice-camera-dock__sr" role="status">{status}</span>
      {view.cameraError ? (
        <div className="voice-camera-dock__error" role="alert">
          <span>{view.cameraError}</span>
          <button type="button" className="button button--ghost" onClick={() => controller.dismissCameraError()}>Dismiss</button>
        </div>
      ) : null}
      {active ? (
        <div className="voice-camera-dock__body">
          <div className={view.cameraWarming || view.camera === "starting" ? "voice-camera-dock__video voice-camera-dock__video--warming" : "voice-camera-dock__video"}>
            {view.camera === "on" ? <video ref={video} muted playsInline autoPlay aria-label="Camera preview" /> : null}
            {live ? <span className="voice-camera-dock__live"><i aria-hidden="true" />LIVE</span> : null}
            <span className="voice-camera-dock__caption">
              {view.camera === "starting" ? "starting camera…"
                : view.cameraWarming ? "first load can take a few minutes"
                  : skipped ? `cue model ${skipped}`
                    : <><span className="voice-camera-dock__caption-wide">no text generation · </span>one forward pass · on-device</>}
            </span>
          </div>
          <div className="voice-camera-dock__reads">
            {(observation ? readings(observation) : placeholders.map((question) => ({ question, pick: "", idle: true, confidence: undefined }))).map((reading) => (
              <div
                key={reading.question}
                className={`voice-camera-dock__read${reading.idle ? " voice-camera-dock__read--idle" : ""}${sent === reading.question ? " voice-camera-dock__read--sent" : ""}`}
              >
                <span className="voice-camera-dock__question">{reading.question}</span>
                {observation ? <span className="voice-camera-dock__pick">{reading.pick}</span> : <span className="voice-camera-dock__skeleton" aria-hidden="true" />}
                {sent === reading.question
                  ? <span className="voice-camera-dock__sent">sent</span>
                  : <span className="voice-camera-dock__percent">{percent(reading.confidence)}</span>}
                <span className="voice-camera-dock__bar-track"><i style={{ width: barWidth(reading.confidence) }} /></span>
              </div>
            ))}
          </div>
          <div className="voice-camera-dock__cards">
            {(observation ? scoreCards(observation) : placeholders.map((question) => ({ question, type: question === "present" ? "noul" as const : "choice" as const, pick: "—", options: [] }))).map((card) => (
              <div key={card.question} className="voice-camera-dock__card">
                <div className="voice-camera-dock__card-head">
                  <span className="voice-camera-dock__question">{card.question}</span>
                  <span className="voice-camera-dock__type">{card.type}</span>
                </div>
                <div className={sent === card.question ? "voice-camera-dock__pick voice-camera-dock__pick--sent" : "voice-camera-dock__pick"}>{card.pick}</div>
                {card.options.map((option) => (
                  <div key={option.label} className={option.selected ? "voice-camera-dock__option voice-camera-dock__option--selected" : "voice-camera-dock__option"}>
                    <span>{option.label}</span>
                    <span>{percent(option.score)}</span>
                    <span className="voice-camera-dock__bar-track"><i style={{ width: barWidth(option.score) }} /></span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {debug ? <p className="voice-camera-dock__filter">{debug.filter}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
