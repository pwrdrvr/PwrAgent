import { useEffect, useMemo, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { NativeVoiceApi } from "../../../../shared/native-voice";
import { getWindowNativeVoiceController } from "./native-voice-controller";
import "./native-voice.css";

export function isNativeVoiceApi(api: DesktopApi | undefined): api is DesktopApi & NativeVoiceApi {
  return Boolean(api?.nativeVoiceCapability && api.startNativeVoice && api.stopNativeVoice
    && api.sendNativeVoiceText && api.onNativeVoiceEvent);
}

export function NativeVoice({ api, threadId }: { api: NativeVoiceApi; threadId?: string }) {
  const controller = useMemo(() => getWindowNativeVoiceController(api), [api]);
  const [view, setView] = useState(() => controller.getView());
  const [text, setText] = useState("");
  useEffect(() => {
    setText("");
    const off = controller.subscribe(setView);
    return () => { off(); void controller.stop(); };
  }, [controller, threadId]);
  const active = view.status !== "idle" && view.status !== "error";
  const sendText = () => {
    if (text.trim()) { void controller.text(text.trim()); setText(""); }
  };
  if (!threadId && !active) return null;
  return (
    <div className="native-voice">
      <div className="native-voice__controls">
        <button className="button button--ghost" type="button" disabled={view.status === "stopping"}
          onClick={() => { if (active) void controller.stop(); else if (threadId) void controller.start(threadId); }}>
          {active ? "Stop voice" : "Start voice"}
        </button>
        <span className="native-voice__status" role={view.status === "idle" ? undefined : "status"} aria-label={view.status === "idle" ? undefined : "Voice status"}>
          {view.status === "listening" ? "Microphone live · speak to interrupt voice" : view.status === "checking" ? "Checking voice access…" : view.status === "connecting" ? "Connecting voice…" : view.status === "stop-error" ? "Voice stop needs retry" : view.status === "stopping" ? "Stopping voice…" : "Experimental · opt in to talk"}
        </span>
      </div>
      {view.error ? <p className="native-voice__error" role="alert">{view.error}</p> : null}
      {view.transcript.length ? (
        <div className="native-voice__transcript" role="log" aria-label="Voice transcript">
          {view.transcript.map((row, index) => <p key={index}><strong>{row.role === "user" ? "You" : "Voice"}: </strong>{row.text}</p>)}
        </div>
      ) : null}
      {view.status === "listening" ? (
        <div className="native-voice__text" onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            if (!event.nativeEvent.isComposing) sendText();
          }
        }}>
          <input className="settings-input" aria-label="Message voice" placeholder="Message voice…" value={text} maxLength={8000} onChange={(event) => setText(event.target.value)} />
          <button className="button button--ghost" type="button" disabled={!text.trim()} onClick={sendText}>Send to voice</button>
        </div>
      ) : null}
    </div>
  );
}
