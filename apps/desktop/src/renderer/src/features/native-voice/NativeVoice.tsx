import { useEffect, useMemo, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { NativeVoiceApi } from "../../../../shared/native-voice";
import { NativeVoiceController, type VoiceView } from "./native-voice-controller";
import "./native-voice.css";

export function isNativeVoiceApi(api: DesktopApi | undefined): api is DesktopApi & NativeVoiceApi {
  return Boolean(api?.nativeVoiceCapability && api.startNativeVoice && api.stopNativeVoice
    && api.sendNativeVoiceText && api.onNativeVoiceEvent);
}

export function NativeVoice({ api, threadId }: { api: NativeVoiceApi; threadId: string }) {
  const [view, setView] = useState<VoiceView>({ status: "idle", transcript: [] });
  const [text, setText] = useState("");
  const controller = useMemo(() => new NativeVoiceController(api, setView), [api]);
  useEffect(() => {
    setView({ status: "idle", transcript: [] });
    const stop = () => { void controller.stop(); };
    window.addEventListener("pagehide", stop);
    return () => { window.removeEventListener("pagehide", stop); stop(); };
  }, [controller, threadId]);
  const active = view.status !== "idle" && view.status !== "error";
  return (
    <div className="native-voice">
      <div className="native-voice__controls">
        <button className="button button--ghost" type="button" disabled={view.status === "stopping"}
          onClick={() => { if (active) void controller.stop(); else void controller.start(threadId); }}>
          {active ? "Stop voice" : "Start voice"}
        </button>
        <span className="native-voice__status" role="status">
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
        <form className="native-voice__text" onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) { void controller.text(text.trim()); setText(""); }
        }}>
          <input className="settings-input" aria-label="Message voice" placeholder="Message voice…" value={text} maxLength={8000} onChange={(event) => setText(event.target.value)} />
          <button className="button button--ghost" type="submit" disabled={!text.trim()}>Send to voice</button>
        </form>
      ) : null}
    </div>
  );
}
