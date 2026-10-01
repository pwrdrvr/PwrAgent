import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { NativeVoiceApi } from "../../../../shared/native-voice";
import { MicIcon } from "../../icons";
import {
  getWindowNativeVoiceController,
  type NativeVoiceController,
  type VoiceView,
} from "./native-voice-controller";
import "./native-voice.css";

export function isNativeVoiceApi(api: DesktopApi | undefined): api is DesktopApi & NativeVoiceApi {
  return Boolean(api?.nativeVoiceCapability && api.startNativeVoice && api.stopNativeVoice
    && api.sendNativeVoiceText && api.onNativeVoiceEvent);
}

/** Subscribe to the window's one voice controller. */
export function useNativeVoice(api: NativeVoiceApi): { controller: NativeVoiceController; view: VoiceView } {
  const controller = useMemo(() => getWindowNativeVoiceController(api), [api]);
  const [view, setView] = useState(() => controller.getView());
  useEffect(() => controller.subscribe(setView), [controller]);
  return { controller, view };
}

export function isVoiceActive(view: VoiceView): boolean {
  return view.status !== "idle" && view.status !== "error";
}

export function voiceStateLabel(view: VoiceView): string {
  switch (view.status) {
    case "checking": return "Checking voice access…";
    case "connecting": return "Connecting voice…";
    case "listening": return view.muted ? "Microphone muted" : "Microphone live";
    case "stopping": return "Ending voice…";
    case "stop-error": return "Voice is still open. End voice again.";
    case "error": return "Voice ended";
    default: return "";
  }
}

/**
 * Five bars driven by the microphone's input level. Written straight to the
 * DOM from an animation frame so a speaking operator does not re-render React
 * sixty times a second. Static under reduced motion.
 */
export function VoiceLevelMeter({ controller }: { controller: NativeVoiceController }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof requestAnimationFrame !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const bars = Array.from(node.children) as HTMLElement[];
    const weights = [0.55, 0.85, 1, 0.8, 0.5];
    let frame = 0;
    const tick = () => {
      const level = controller.readLevel();
      bars.forEach((bar, index) => {
        bar.style.transform = `scaleY(${Math.max(0.25, Math.min(1, level * weights[index] * 1.8))})`;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [controller]);
  return (
    <span className="native-voice-meter" ref={ref} aria-hidden="true">
      <i /><i /><i /><i /><i />
    </span>
  );
}

/** The live state: a dot and meter while the microphone is open, text otherwise. */
export function VoiceStatus({ controller, view }: { controller: NativeVoiceController; view: VoiceView }) {
  const live = view.status === "listening" && !view.muted;
  return (
    <span
      className={live ? "native-voice__status native-voice__status--live" : "native-voice__status"}
      role="status"
      aria-label="Voice status"
    >
      {live ? <VoiceLevelMeter controller={controller} /> : null}
      {voiceStateLabel(view)}
    </span>
  );
}

/** Transcript rows and tool receipts, in the order they happened. */
export function VoiceFeed({ view, limit }: { view: VoiceView; limit?: number }) {
  const rows = useMemo(() => {
    const merged = [
      ...view.transcript.map((row) => ({ kind: "say" as const, ...row })),
      ...view.actions.map((row) => ({ kind: "action" as const, ...row })),
    ].sort((left, right) => left.seq - right.seq);
    return limit ? merged.slice(-limit) : merged;
  }, [view.transcript, view.actions, limit]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [rows]);
  if (!rows.length) return null;
  return (
    <div className="native-voice-feed" ref={ref} role="log" aria-label="Voice transcript">
      {rows.map((row) => row.kind === "say" ? (
        <p key={`say-${row.seq}`} className="native-voice-feed__say">
          <strong>{row.role === "user" ? "You" : "Voice"}: </strong>{row.text}
        </p>
      ) : (
        <p key={`action-${row.seq}`} className={row.ok ? "native-voice-feed__action" : "native-voice-feed__action native-voice-feed__action--failed"}>
          <span className="native-voice-feed__tool">{row.tool}</span>
          {row.target ? <span className="native-voice-feed__target">{row.target}</span> : null}
          {row.instance ? <span className="native-voice-feed__instance">on {row.instance}</span> : null}
          <span className="native-voice-feed__outcome">{row.ok ? row.outcome ?? "done" : "failed"}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Typed text for the voice conversation. Its own input with an explicit
 * button, never a nested form: Enter is consumed here so it cannot submit
 * the coding draft or a configured review.
 */
export function VoiceTextInput({ controller }: { controller: NativeVoiceController }) {
  const [text, setText] = useState("");
  const sendText = () => {
    if (text.trim()) { void controller.text(text.trim()); setText(""); }
  };
  return (
    <div className="native-voice__text" onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        if (!event.nativeEvent.isComposing) sendText();
      }
    }}>
      <input className="native-voice__input" aria-label="Message voice" placeholder="Message voice…" value={text} maxLength={8000} onChange={(event) => setText(event.target.value)} />
      <button className="button button--ghost" type="button" disabled={!text.trim()} onClick={sendText}>Send to voice</button>
    </div>
  );
}

/**
 * The composer's mic toggle. Talks to this thread; ends when the operator
 * leaves it. Unavailable while overseer voice owns the window's session.
 */
export function NativeVoiceToggle({ api, threadId }: { api: NativeVoiceApi; threadId?: string }) {
  const { controller, view } = useNativeVoice(api);
  if (!threadId) return null;
  const mine = view.mode === "thread" && view.threadId === threadId && isVoiceActive(view);
  const elsewhere = isVoiceActive(view) && !mine;
  const tooltip = elsewhere
    ? view.mode === "overseer"
      ? "Overseer voice is on. End it to talk to this thread."
      : "Voice is on in another thread."
    : mine ? "End voice" : "Talk to this thread";
  return (
    <button
      type="button"
      className={`composer__toggle tooltip-target${mine ? " is-active" : ""}`}
      aria-label="Voice"
      aria-pressed={mine}
      aria-disabled={elsewhere || view.status === "stopping" ? true : undefined}
      data-tooltip={tooltip}
      onClick={() => {
        if (elsewhere || view.status === "stopping") return;
        if (mine) void controller.stop();
        else void controller.start(threadId, "thread");
      }}
    >
      <MicIcon size={15} aria-hidden="true" />
    </button>
  );
}

/**
 * Thread voice, docked above the composer while it runs. Owns the rule that
 * leaving the thread ends its voice, and shows a failed stop on whatever
 * composer the window lands on so it can be retried.
 */
export function NativeVoiceBar({ api, threadId }: { api: NativeVoiceApi; threadId?: string }) {
  const { controller, view } = useNativeVoice(api);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  useEffect(() => {
    setOpen(false);
    return () => {
      const current = controller.getView();
      if (current.mode === "thread" && threadId && current.threadId === threadId) void controller.stop();
    };
  }, [controller, threadId]);
  const visible = view.mode === "thread" && view.status !== "idle"
    && (view.threadId === threadId || view.status === "stop-error" || view.status === "stopping");
  if (!visible) return null;
  const last = view.transcript[view.transcript.length - 1];
  const listening = view.status === "listening";
  return (
    <section className="native-voice-bar" aria-label="Thread voice">
      <div className="native-voice-bar__row">
        <VoiceStatus controller={controller} view={view} />
        <span className="native-voice-bar__tick">
          {last ? <><strong>{last.role === "user" ? "You" : "Voice"}:</strong> {last.text}</> : null}
        </span>
        {listening ? (
          <button className="button button--ghost" type="button" aria-pressed={view.muted} onClick={() => controller.setMuted(!view.muted)}>
            {view.muted ? "Unmute" : "Mute"}
          </button>
        ) : null}
        {listening || view.transcript.length || view.actions.length ? (
          <button className="button button--ghost" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
            Transcript
          </button>
        ) : null}
        {view.status === "error" ? (
          <button className="button button--ghost" type="button" onClick={() => controller.dismissError()}>Dismiss</button>
        ) : (
          <button className="button button--ghost native-voice__end" type="button" disabled={view.status === "stopping"} onClick={() => void controller.stop()}>
            End voice
          </button>
        )}
      </div>
      {view.error ? <p className="native-voice__error" role="alert">{view.error}</p> : null}
      {open ? (
        <div className="native-voice-bar__panel" id={panelId}>
          <VoiceFeed view={view} />
          {listening ? <VoiceTextInput controller={controller} /> : null}
        </div>
      ) : null}
    </section>
  );
}
