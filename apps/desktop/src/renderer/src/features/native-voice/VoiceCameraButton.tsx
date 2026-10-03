import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NativeVoiceApi } from "../../../../shared/native-voice";
import { useNativeVoice } from "./NativeVoice";

export function VoiceCameraButton({ api }: { api: NativeVoiceApi }) {
  const { controller, view } = useNativeVoice(api);
  const anchor = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const hasPanel = Boolean(position);
  const video = useRef<HTMLVideoElement>(null);
  const active = Boolean(view.camera);
  useEffect(() => {
    const element = video.current;
    if (!element || view.camera !== "on") return;
    element.srcObject = controller.cameraStream() ?? null;
    void element.play().catch(() => undefined);
    return () => { element.srcObject = null; };
  }, [controller, view.camera, hasPanel]);
  useEffect(() => {
    if (!active && !view.cameraError) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) { setPosition(undefined); return; }
      setPosition({ top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 230)), left: Math.max(8, Math.min(rect.left, window.innerWidth - 208)) });
    };
    place();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : undefined;
    if (anchor.current) observer?.observe(anchor.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [active, view.cameraError]);
  if (view.status !== "listening" && !view.cameraError) return null;
  const label = active ? "Turn off camera cues" : "Turn on camera cues";
  return (
    <span className="voice-camera" ref={anchor}>
      <button
        type="button"
        className={`sidebar__icon-button${active ? " is-active" : ""}`}
        aria-label={label}
        aria-pressed={active}
        title={`${label}. Frames stay on this machine. Voice ends after 30 seconds away.`}
        disabled={view.status !== "listening"}
        onClick={() => { void controller.setCamera(!active); }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="6" width="13" height="12" rx="2" />
          <path d="m16 10 5-3v10l-5-3" />
        </svg>
      </button>
      {(active || view.cameraError) && position ? createPortal(
        <span className="voice-camera__panel" style={position}>
          {view.camera === "on" ? <video ref={video} muted playsInline autoPlay className="voice-camera__preview" /> : null}
          <span className="voice-camera__status" role={view.cameraError ? "alert" : "status"}>
            {view.cameraError ?? (view.camera === "starting" ? "Starting camera…"
              : view.cameraWarming ? "Camera cues · warming up…" : `Camera cues · ${view.cameraCue ?? "observing"}`)}
          </span>
          {view.cameraError ? <button type="button" className="button button--ghost" onClick={() => controller.dismissCameraError()}>Dismiss</button> : null}
          {active ? <span className="voice-camera__hint">{view.cameraWarming ? "Model loading can take a few minutes." : "Local analysis · ends voice after 30s away"}</span> : null}
        </span>, document.body,
      ) : null}
    </span>
  );
}
