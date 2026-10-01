import type { NativeVoiceEvent, NativeVoiceMode, NativeVoiceStart, NativeVoiceTarget, NativeVoiceText } from "../../shared/native-voice";
import { describeNativeVoiceAction, type NativeVoiceBackend, type NativeVoiceNotification } from "./native-voice-protocol";

/** What the realtime model is told it is, per mode. Both keep replies short. */
export const NATIVE_VOICE_PROMPTS: Record<NativeVoiceMode, string> = {
  thread: "You are the voice interface for this coding thread. Discuss progress and delegate coding requests to Codex, which has the PwrAgent tool catalog. Spoken interruptions change the conversation; do not cancel coding work unless the operator explicitly requests task cancellation. Stopping voice leaves coding work running. Keep replies brief. Do not perform calendar, email, or personal administration tasks.",
  overseer: "You are the operator's voice interface for overseeing every PwrAgent thread, on this machine and on connected peer machines. Delegate every request to Codex, which has the PwrAgent tool catalog: it can search and read threads, report status, send messages to threads, steer or stop their turns, and hand off new tasks. When the operator says \"this thread\" or \"the one I'm looking at\", have Codex call read_operator_focus first. Confirm the target thread and machine before asking Codex to stop a turn. Report only what a tool result says happened. Stopping voice leaves all work running. Keep replies brief. Do not perform calendar, email, or personal administration tasks.",
};

type EventPayload<T = NativeVoiceEvent> = T extends NativeVoiceEvent ? Omit<T, "sessionId"> : never;

type Session = {
  owner: number;
  request: NativeVoiceStart;
  emit: (event: NativeVoiceEvent) => void;
  backend?: NativeVoiceBackend;
  off: Array<() => void>;
  cancelled: boolean;
  disconnected?: boolean;
  established?: boolean;
  released?: boolean;
  start: Promise<void>;
  stop?: Promise<void>;
};

/** One voice session per backend process; all windows share this owner. */
export class NativeVoiceSessionManager {
  private session?: Session;

  constructor(private readonly acquire: (threadId: string) => Promise<NativeVoiceBackend>) {}

  start(owner: number, request: NativeVoiceStart, emit: Session["emit"]): Promise<void> {
    if (this.session) return Promise.reject(new Error("A voice session is already open. Stop it before starting another."));
    const session: Session = { owner, request, emit, off: [], cancelled: false, start: Promise.resolve() };
    this.session = session;
    session.start = this.establish(session);
    return session.start;
  }

  private async establish(session: Session): Promise<void> {
    try {
      const backend = await this.acquire(session.request.threadId);
      session.backend = backend;
      if (session.cancelled) return;
      session.off.push(backend.onEvent((event) => this.onEvent(session, event)));
      const offToolCall = backend.onToolCall?.((call) => {
        if (call.threadId !== session.request.threadId || session.cancelled) return;
        this.emit(session, { type: "action", ...describeNativeVoiceAction(call) });
      });
      if (offToolCall) session.off.push(offToolCall);
      session.off.push(backend.onDisconnect(() => {
        session.disconnected = true;
        if (session.cancelled) this.release(session);
        else {
          this.emit(session, { type: "error", message: "Voice backend disconnected." });
          void this.stop(session.owner, session.request).catch(() => undefined);
        }
      }));
      await backend.start({
        threadId: session.request.threadId,
        realtimeSessionId: session.request.sessionId,
        version: "v3",
        outputModality: "audio",
        transport: { type: "webrtc", sdp: session.request.sdp },
        clientManagedHandoffs: false,
        flushTranscriptTailOnSessionEnd: false,
        prompt: NATIVE_VOICE_PROMPTS[session.request.mode ?? "thread"],
      });
      session.established = true;
    } catch (error) {
      this.emit(session, { type: "error", message: error instanceof Error ? error.message : "Voice startup failed." });
      // Do not await stop here: stop waits for this startup promise to settle.
      void this.stop(session.owner, session.request).catch(() => undefined);
      throw error;
    }
  }

  private emit(session: Session, event: EventPayload): void {
    if (this.session === session && !session.cancelled) {
      session.emit({ ...event, sessionId: session.request.sessionId } as NativeVoiceEvent);
    }
  }

  private onEvent(session: Session, event: NativeVoiceNotification): void {
    if (event.params.threadId !== session.request.threadId || session.cancelled) return;
    switch (event.method) {
      case "thread/realtime/sdp":
        this.emit(session, { type: "sdp", sdp: event.params.sdp });
        break;
      case "thread/realtime/started":
        this.emit(session, { type: "started", version: event.params.version });
        break;
      case "thread/realtime/transcript/delta":
        this.emit(session, { type: "transcript", role: event.params.role, text: event.params.delta, done: false });
        break;
      case "thread/realtime/transcript/done":
        this.emit(session, { type: "transcript", role: event.params.role, text: event.params.text, done: true });
        break;
      case "thread/realtime/error":
        this.emit(session, { type: "error", message: event.params.message });
        void this.stop(session.owner, session.request).catch(() => undefined);
        break;
      case "thread/realtime/closed":
        this.emit(session, { type: "closed", reason: event.params.reason ?? undefined });
        void this.stop(session.owner, session.request).catch(() => undefined);
        break;
    }
  }

  stop(owner: number, request: NativeVoiceTarget): Promise<void> {
    const session = this.session;
    if (!session || session.owner !== owner || session.request.sessionId !== request.sessionId) return Promise.resolve();
    if (session.stop) return session.stop;
    session.cancelled = true;
    session.stop = (async () => {
      try {
        // A late start response must be followed by stop before admitting a
        // replacement session on the same thread (SDP carries no session id).
        await session.start.catch(() => undefined);
        if (!session.disconnected) await session.backend?.stop(session.request.threadId);
        this.release(session);
      } catch (error) {
        // Keep ownership when the service could still be live. A retry or a
        // backend disconnect can release it; a second session cannot race it.
        session.stop = undefined;
        if (session.disconnected) this.release(session);
        throw error;
      }
    })();
    return session.stop;
  }

  private release(session: Session): void {
    if (session.released) return;
    session.released = true;
    for (const off of session.off.splice(0)) off();
    session.backend?.release();
    if (this.session === session) this.session = undefined;
    session.emit({ type: "closed", sessionId: session.request.sessionId });
  }

  allowsMicrophone(owner: number): boolean {
    return this.session?.owner === owner && this.session.established === true && !this.session.cancelled;
  }

  stopOwner(owner: number): Promise<void> {
    const session = this.session;
    return session?.owner === owner ? this.stop(owner, session.request) : Promise.resolve();
  }

  async text(owner: number, request: NativeVoiceText): Promise<void> {
    const session = this.session;
    if (!session || session.owner !== owner || session.request.sessionId !== request.sessionId || session.cancelled) {
      throw new Error("No voice session is open in this window.");
    }
    await session.start;
    if (!session.cancelled) await session.backend?.text(session.request.threadId, request.text);
  }
}
