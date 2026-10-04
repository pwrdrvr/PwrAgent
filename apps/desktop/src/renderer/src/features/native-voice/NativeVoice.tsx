import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { NativeVoiceApi } from "../../../../shared/native-voice";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import { MicIcon, MicOffIcon } from "../../icons";
import { formatElapsedMs } from "../../lib/format-duration";
import { tooltipHandlers, useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  getWindowNativeVoiceController,
  MUTED_IDLE_END_MS,
  type NativeVoiceController,
  type VoiceView,
} from "./native-voice-controller";
import { CameraGlyph, cameraCueLabel } from "./VoiceCameraButton";
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

export const NATIVE_VOICE_ERROR_NOTICE_ID = "native-voice-error";
export const NATIVE_VOICE_ENDED_NOTICE_ID = "native-voice-ended";

/**
 * A voice failure is an ordinary app notice, raised through the notice
 * library like any other, not a bespoke card on the voice controls. The
 * controls clear the moment the failure is handed over; the notice stays
 * until it is closed or the next start begins.
 */
export function useNativeVoiceNotices(
  api: NativeVoiceApi | undefined,
  showNotice: (notice: AppNoticeToastNotice) => void,
  dismissNotice: (id: string) => void,
): void {
  useEffect(() => {
    if (!api) return;
    const controller = getWindowNativeVoiceController(api);
    let previous = controller.getView().status;
    return controller.subscribe((view) => {
      const ended = previous !== "idle" && view.status === "idle";
      previous = view.status;
      // Director voice keeps its panel open after the session, and the
      // panel says how it ended; the notice is for thread voice's bar.
      if (ended && (view.endedAfterReply || view.endedAfterAway) && view.mode !== "director") {
        showNotice({
          id: NATIVE_VOICE_ENDED_NOTICE_ID,
          title: "Live voice",
          message: view.endedAfterAway ? "Voice ended because the camera detected 30 seconds away." : "Voice ended after its reply because the microphone was muted.",
          tone: "neutral",
        });
      } else if (view.status === "error") {
        showNotice({
          id: NATIVE_VOICE_ERROR_NOTICE_ID,
          title: "Live voice",
          message: view.error ?? "Voice ended.",
          tone: "error",
          autoDismiss: false,
        });
        // Not inside the controller's own publish loop.
        queueMicrotask(() => controller.dismissError());
      } else if (view.status === "checking" || view.status === "connecting") {
        dismissNotice(NATIVE_VOICE_ERROR_NOTICE_ID);
      }
    });
  }, [api, showNotice, dismissNotice]);
}

export function isVoiceActive(view: VoiceView): boolean {
  return view.status !== "idle" && view.status !== "error";
}

export function voiceStateLabel(view: VoiceView): string {
  switch (view.status) {
    case "checking": return "Checking voice access…";
    case "connecting": return "Connecting voice…";
    case "listening": return view.muted ? "Muted, ends after the reply" : "Microphone live";
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

/**
 * How long the session has been live, ticking each second: the time the
 * operator is paying for. Its own state, so the tick re-renders only this.
 * With `until`, the session is over and the clock stands still.
 */
export function VoiceElapsed({ since, until }: { since?: number; until?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined || until !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since, until]);
  if (since === undefined) return null;
  const elapsed = formatElapsedMs((until ?? now) - since);
  return (
    <span
      className="native-voice__elapsed"
      role="timer"
      aria-label={until === undefined ? `Voice open for ${elapsed}` : `Voice was open for ${elapsed}`}
    >
      {elapsed}
    </span>
  );
}

const MUTED_IDLE_END_SECONDS = Math.round(MUTED_IDLE_END_MS / 1000);

/**
 * The microphone, as a toggle. Muting never cuts a reply off: the voice keeps
 * answering, and once it has finished and its turn is done the session ends
 * itself, so "ask, mute, listen" does not leave voice open.
 */
export function VoiceMicToggle({
  controller, tooltipClassName = "viewport-tooltip", view,
}: {
  controller: NativeVoiceController;
  /** A floating host passes its own layer: the tooltip portals out of it. */
  tooltipClassName?: string;
  view: VoiceView;
}) {
  const tooltip = useViewportTooltip({ className: tooltipClassName });
  if (view.status !== "listening") return null;
  return (
    <>
      <button
        // The masthead mic's own class: the same button, active while live.
        className={`sidebar__icon-button${view.muted ? "" : " is-active"}`}
        type="button"
        aria-label={view.muted ? "Unmute microphone" : "Mute microphone"}
        aria-describedby={tooltip.visible ? tooltip.tooltipId : undefined}
        {...tooltipHandlers(tooltip, micHint(view.muted))}
        onClick={(event) => {
          controller.setMuted(!view.muted);
          // The open hint describes the state just left; show the new one.
          tooltip.show(event.currentTarget, micHint(!view.muted));
        }}
      >
        {view.muted ? <MicOffIcon size={16} aria-hidden="true" /> : <MicIcon size={16} aria-hidden="true" />}
      </button>
      {tooltip.tooltipNode}
    </>
  );
}

function micHint(muted: boolean): string {
  return muted
    ? `Muted. Voice ends ${MUTED_IDLE_END_SECONDS} seconds after its reply finishes. Unmute to keep talking.`
    : `Mute. The reply keeps playing, then voice ends ${MUTED_IDLE_END_SECONDS} seconds after it finishes.`;
}

const CUE_DELIVERY_LABEL = { pending: "sending…", acknowledged: "sent", failed: "not delivered" } as const;

/**
 * Transcript rows, tool receipts, and sent camera cues, in the order they
 * happened. A cue is a moment like a tool call, so it reads back in place:
 * "did it see my stop?" is answered by the transcript. `assistant` names
 * the speaker: the director panel says Director, thread voice says Voice.
 */
export function VoiceFeed({ view, limit, scrollParent = false, assistant = "Voice" }: {
  view: VoiceView;
  limit?: number;
  scrollParent?: boolean;
  assistant?: string;
}) {
  const rows = useMemo(() => {
    const merged = [
      ...view.transcript.map((row) => ({ kind: "say" as const, ...row })),
      ...view.actions.map((row) => ({ kind: "action" as const, ...row })),
      ...(view.cameraCues ?? []).map((row) => ({ kind: "cue" as const, ...row })),
    ].sort((left, right) => left.seq - right.seq);
    return limit ? merged.slice(-limit) : merged;
  }, [view.transcript, view.actions, view.cameraCues, limit]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (scrollParent && node.parentElement) {
      const parent = node.parentElement;
      parent.scrollTop = Math.max(0, node.offsetTop - parent.offsetTop + node.offsetHeight - parent.clientHeight);
    } else node.scrollTop = node.scrollHeight;
  }, [rows, scrollParent]);
  if (!rows.length) return null;
  return (
    <div className="native-voice-feed" ref={ref} role="log" aria-label="Voice transcript">
      {rows.map((row) => row.kind === "say" ? (
        <p key={`say-${row.seq}`} className={row.role === "user" ? "native-voice-feed__say" : "native-voice-feed__say native-voice-feed__say--assistant"}>
          <strong>{row.role === "user" ? "You" : assistant}: </strong>{row.text}
        </p>
      ) : row.kind === "cue" ? (
        <p key={`cue-${row.seq}`} className={`native-voice-feed__cue native-voice-feed__cue--${row.delivery}`}>
          <CameraGlyph />
          <span className="native-voice-feed__cue-kind">camera</span>
          <span className="native-voice-feed__cue-name">{cameraCueLabel(row.cue)}</span>
          <span className="native-voice-feed__cue-outcome">{CUE_DELIVERY_LABEL[row.delivery]}</span>
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
export function VoiceTextInput({ controller, recipient = "voice", sendLabel = "Send to voice" }: {
  controller: NativeVoiceController;
  /** Who the message goes to, in the field's name and placeholder. */
  recipient?: string;
  sendLabel?: string;
}) {
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
      <input className="native-voice__input" aria-label={`Message ${recipient}`} placeholder={`Message ${recipient}…`} value={text} maxLength={8000} onChange={(event) => setText(event.target.value)} />
      <button className="button button--ghost" type="button" disabled={!text.trim()} onClick={sendText}>{sendLabel}</button>
    </div>
  );
}

/**
 * Which voice a composer's mic starts. Thread voice runs on this machine's
 * Codex App Server, so it opens only on a local Codex thread. Everywhere
 * else it starts director voice, which reaches a peer's thread, another
 * provider's, and a new-thread launchpad through the PwrAgent tools; the
 * hint says what that will do.
 */
export function threadVoiceTarget(
  thread: { id: string; source: string; federation?: { instanceLabel?: string } } | undefined,
  launchpad: { directoryLabel: string } | undefined,
): { threadId?: string; directorHint?: string } {
  if (launchpad) {
    return {
      directorHint: `Say what the new thread should do. Director voice starts it in ${launchpad.directoryLabel} with these settings.`,
    };
  }
  if (!thread) return {};
  if (thread.federation) {
    return {
      directorHint: `Talk to this thread on ${thread.federation.instanceLabel ?? "another machine"} through director voice.`,
    };
  }
  if (thread.source !== "codex") {
    return { directorHint: "Talk to this thread through director voice." };
  }
  return { threadId: thread.id };
}

/**
 * The composer's mic toggle. Talks to this thread; ends when the operator
 * leaves it. Unavailable while director voice owns the window's session.
 */
export function NativeVoiceToggle({ api, threadId, turnRunning }: {
  api: NativeVoiceApi;
  threadId?: string;
  /** The thread's turn is already running, so a muted session waits for it. */
  turnRunning?: boolean;
}) {
  const { controller, view } = useNativeVoice(api);
  if (!threadId) return null;
  const mine = view.mode === "thread" && view.threadId === threadId && isVoiceActive(view);
  const elsewhere = isVoiceActive(view) && !mine;
  const tooltip = elsewhere
    ? view.mode === "director"
      ? "Director voice is on. End it to talk to this thread."
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
        else void controller.start(threadId, "thread", { turnActive: turnRunning === true });
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
  const visible = view.mode === "thread" && view.status !== "idle" && view.status !== "error"
    && (view.threadId === threadId || view.status === "stop-error" || view.status === "stopping");
  if (!visible) return null;
  const last = view.transcript[view.transcript.length - 1];
  const listening = view.status === "listening";
  return (
    <section className="native-voice-bar" aria-label="Thread voice">
      <div className="native-voice-bar__row">
        <VoiceStatus controller={controller} view={view} />
        <VoiceElapsed since={view.liveSince} />
        <span className="native-voice-bar__spacer" />
        <VoiceMicToggle controller={controller} view={view} />
        {listening || view.transcript.length || view.actions.length ? (
          <button className="button button--ghost" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
            Transcript
          </button>
        ) : null}
        <button className="button button--ghost native-voice__end" type="button" disabled={view.status === "stopping"} onClick={() => void controller.stop()}>
          End voice
        </button>
      </div>
      {/* The latest line in full: a spoken reply cut off at an ellipsis is
          the one thing the operator came to read. */}
      {last && !open ? (
        <p className="native-voice-bar__latest">
          <strong>{last.role === "user" ? "You" : "Voice"}:</strong> {last.text}
        </p>
      ) : null}
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
