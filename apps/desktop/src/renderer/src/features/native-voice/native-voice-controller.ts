import { CAMERA_SAMPLE_GAP_MS, CameraCueFilter, openVoiceCamera, type CameraCapture } from "./voice-camera";
import type { NativeVoiceAction, NativeVoiceApi, NativeVoiceEvent, NativeVoiceMode } from "../../../../shared/native-voice";
import { CAMERA_GESTURES, type CameraCue, type VoiceCameraObservation } from "../../../../shared/native-voice-camera";

export type VoiceCameraDiagnostics = {
  sessionId: string;
  threadId: string;
  startedAt: number;
  observations: number;
  staleObservations: number;
  rateHz: number;
  lastObservedAt?: number;
  frameAgeMs?: number;
  observation?: VoiceCameraObservation;
  filter: string;
  cuesAcknowledged: number;
  lastCue?: CameraCue;
  delivery?: "pending" | "acknowledged" | "failed";
  acknowledgedAt?: number;
  /** Why Clef skipped the latest frame; cleared by the next result. */
  skipped?: "busy" | "offline";
  skippedFrames?: number;
  /** Decisions Clef reported running or waiting while it was busy. */
  inFlight?: number;
  error?: string;
};

export type VoiceStatus = "idle" | "checking" | "connecting" | "listening" | "stopping" | "stop-error" | "error";
/** `seq` orders transcript rows and action receipts against each other. */
export type VoiceTranscriptRow = { role: string; text: string; seq: number };
export type VoiceActionRow = NativeVoiceAction & { seq: number };
/** Gestures and presence go in the transcript; vibes stay in the dock. */
export function isTranscriptCue(cue: CameraCue): boolean {
  return cue === "away" || CAMERA_GESTURES.some((gesture) => gesture === cue);
}

/** A camera cue handed to the voice, in order with what was said. */
export type VoiceCameraCueRow = { cue: CameraCue; seq: number; delivery: "pending" | "acknowledged" | "failed" };
export type VoiceView = {
  status: VoiceStatus;
  error?: string;
  /** Which kind of session this is, and the thread it talks through. Kept while stopping. */
  mode?: NativeVoiceMode;
  threadId?: string;
  /** The operator muted their microphone; the session stays open. */
  muted: boolean;
  camera?: "starting" | "on";
  cameraWarming?: boolean;
  cameraCue?: string;
  cameraError?: string;
  /** Why Settings keeps camera cues off for this session, if it does. */
  cameraUnavailable?: string;
  cameraDiagnostics?: VoiceCameraDiagnostics;
  endedAfterAway?: boolean;
  /** When the session went live, for the elapsed-time label. Billing runs from here. */
  liveSince?: number;
  /** The last session ended itself: muted, with its reply finished. */
  endedAfterReply?: boolean;
  transcript: VoiceTranscriptRow[];
  actions: VoiceActionRow[];
  cameraCues?: VoiceCameraCueRow[];
};
type Meter = { read: () => number; close: () => void };
type Resources = {
  id: string;
  camera?: { cancelled: boolean; capture?: CameraCapture; timer?: ReturnType<typeof setTimeout> };
  meter?: Meter;
  peer?: RTCPeerConnection;
  stream?: MediaStream;
  audio?: HTMLAudioElement;
  off?: () => void;
  offTurns?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** A turn is running on the voice session's thread: the reply is not done. */
  turnActive: boolean;
  finishIce?: () => void;
  started: boolean;
  accepted: boolean;
  activating: boolean;
  cancelled: boolean;
  stop?: Promise<void>;
};
export type VoiceBrowser = {
  peer: () => RTCPeerConnection;
  audio: () => HTMLAudioElement;
  microphone: () => Promise<MediaStream>;
  id: () => string;
  camera?: () => Promise<CameraCapture>;
  /** Input level for the live meter. Optional: voice works without one. */
  meter?: (stream: MediaStream) => Meter | undefined;
};
const browser: VoiceBrowser = {
  peer: () => new RTCPeerConnection(),
  audio: () => new Audio(),
  microphone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }),
  id: () => crypto.randomUUID(),
  camera: openVoiceCamera,
  meter: (stream) => {
    if (typeof AudioContext !== "function") return undefined;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    // Analysis only: the source is never connected to the destination, so
    // the operator does not hear their own microphone.
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    return {
      read: () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        return Math.min(1, Math.sqrt(sum / samples.length) * 4);
      },
      close: () => { void context.close().catch(() => undefined); },
    };
  },
};

/**
 * How long a muted session waits, with nothing said and no turn running,
 * before it ends itself. Muting never interrupts a reply: the microphone sends
 * silence and the voice keeps answering. The session then stays open only
 * for this long after its last word, so "ask, mute, listen" cannot leave a
 * session open for hours.
 */
export const MUTED_IDLE_END_MS = 30_000;
/**
 * The ceiling on a muted session that still looks busy: a turn that runs for
 * an hour, a turn blocked on a question, or a reply whose last line never
 * reports done. Counted from the last sign of activity, so a turn that keeps
 * producing receipts or speech keeps the session.
 */
export const MUTED_STALL_END_MS = 10 * 60_000;
const TURN_STARTED = new Set(["turn/started"]);
const TURN_ENDED = new Set(["turn/completed", "turn/failed", "turn/cancelled"]);

const MAX_TRANSCRIPT_ROWS = 40;
const MAX_ACTION_ROWS = 20;
// A busy Clef keeps serving whoever holds it, and an abandoned request still
// runs to completion there, so back off instead of queueing more frames. An
// offline one is retried on the same schedule and recovers on its own.
const CAMERA_SKIP_RETRY_MS = 2000;
const CAMERA_SKIP_RETRY_MAX_MS = 16_000;
/** An IPC failure's own message, without Electron's "Error invoking remote method" wrapper. */
const cameraErrorText = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "") || "Camera cues failed."
  : "Camera cues failed.";

/** Owns every track, peer, audio element and listener for one window. */
export class NativeVoiceController {
  private resources?: Resources;
  private view: VoiceView = { status: "idle", muted: false, transcript: [], actions: [] };
  /**
   * The row each speaker is still streaming into. Speech and reply stream at
   * once: the operator's words finish ("done") while the voice is already
   * answering, so one shared "current row" split the reply and repeated the
   * operator's line.
   */
  private openRows = new Map<string, number>();
  private seq = 0;
  private readonly listeners = new Set<(view: VoiceView) => void>();
  constructor(
    private readonly api: NativeVoiceApi,
    private readonly update: (view: VoiceView) => void = () => {},
    private readonly platform: VoiceBrowser = browser,
  ) {}

  getView(): VoiceView { return this.view; }
  hasSession(): boolean { return this.resources !== undefined; }
  subscribe(listener: (view: VoiceView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => { this.listeners.delete(listener); };
  }

  private publish(change: Partial<VoiceView>): void {
    this.view = { ...this.view, ...change };
    this.update(this.view);
    for (const listener of this.listeners) listener(this.view);
  }
  private current(resources: Resources): boolean {
    return this.resources === resources && !resources.cancelled;
  }

  /** Microphone input level, 0 to 1, or 0 when nothing is measuring it. */
  readLevel(): number {
    const resources = this.resources;
    if (!resources?.meter || this.view.muted || this.view.status !== "listening") return 0;
    return resources.meter.read();
  }

  /** Clear a startup failure once the operator has read it. */
  dismissError(): void {
    if (this.resources || this.view.status !== "error") return;
    this.publish({ status: "idle", error: undefined, mode: undefined, threadId: undefined, muted: false });
  }

  /** Show a failure that happened before a session existed, such as resolving its thread. */
  reportError(message: string, mode: NativeVoiceMode): void {
    if (this.resources) return;
    this.publish({ status: "error", error: message, mode, threadId: undefined, muted: false, transcript: [], actions: [], cameraCues: [] });
  }

  /**
   * Mute or unmute the microphone without closing the session. A reply in
   * progress continues; once it is done the muted session ends itself.
   */
  setMuted(muted: boolean): void {
    const resources = this.resources;
    if (!resources || this.view.status !== "listening") return;
    for (const track of resources.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.publish({ muted });
    this.armMutedIdleEnd(resources);
  }

  /**
   * (Re)start the muted-idle countdown. Anything that shows the session is
   * still working (a word streaming in, a tool receipt, a turn running on
   * its thread, the operator unmuting) clears it.
   */
  private armMutedIdleEnd(resources: Resources): void {
    clearTimeout(resources.idleTimer);
    resources.idleTimer = undefined;
    if (!this.current(resources) || !this.view.muted || this.view.status !== "listening") return;
    const busy = this.openRows.size > 0 || resources.turnActive;
    resources.idleTimer = setTimeout(() => {
      if (!this.current(resources) || !this.view.muted || this.view.status !== "listening") return;
      this.publish({ endedAfterReply: true });
      void this.stop();
    }, busy ? MUTED_STALL_END_MS : MUTED_IDLE_END_MS);
  }

  private watchTurns(resources: Resources, threadId: string): void {
    resources.offTurns = this.api.onAgentEvent?.((event) => {
      if (!this.current(resources)) return;
      const params = event.notification.params as { threadId?: unknown };
      if (params.threadId !== threadId) return;
      if (TURN_STARTED.has(event.notification.method)) resources.turnActive = true;
      else if (TURN_ENDED.has(event.notification.method)) resources.turnActive = false;
      else return;
      this.armMutedIdleEnd(resources);
    });
  }

  /**
   * `turnActive` seeds whether the thread's turn is already running: only
   * turns that start after this are seen as events, and a running one must
   * not let a muted session end before it reports.
   */
  async start(threadId: string, mode: NativeVoiceMode = "thread", options: { turnActive?: boolean } = {}): Promise<void> {
    if (this.resources) return;
    const resources: Resources = {
      id: this.platform.id(), started: false, accepted: false, activating: false, cancelled: false,
      turnActive: options.turnActive === true,
    };
    this.resources = resources;
    this.openRows.clear();
    this.publish({
      status: "checking", error: undefined, mode, threadId, muted: false,
      liveSince: undefined, endedAfterReply: undefined, endedAfterAway: undefined, camera: undefined, cameraWarming: undefined, cameraCue: undefined, cameraError: undefined, cameraUnavailable: undefined, cameraDiagnostics: undefined, transcript: [], actions: [], cameraCues: [],
    });
    this.watchTurns(resources, threadId);
    try {
      const capability = await this.api.nativeVoiceCapability();
      if (!this.current(resources)) return;
      if (!capability.available) throw new Error(capability.reason ?? "Live voice is unavailable.");
      this.publish({
        status: "connecting",
        cameraUnavailable: capability.camera?.available === false ? capability.camera.reason ?? "Camera cues are off." : undefined,
      });
      const peer = this.platform.peer();
      resources.peer = peer;
      resources.audio = this.platform.audio();
      resources.audio.autoplay = true;
      const transceiver = peer.addTransceiver("audio", { direction: "sendrecv" });
      // Codex negotiates the call and sideband. No tokens, URLs or raw service
      // commands enter the renderer; this channel belongs to the negotiated peer.
      peer.createDataChannel("oai-events");
      peer.ontrack = (event) => {
        if (!this.current(resources) || !resources.audio) return;
        resources.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void resources.audio.play().catch((error: unknown) => this.fail(resources, error));
      };
      peer.onconnectionstatechange = () => {
        if (!this.current(resources)) return;
        if (peer.connectionState === "failed" || peer.connectionState === "disconnected" || peer.connectionState === "closed") {
          this.fail(resources, new Error("Voice audio connection closed."));
        } else if (peer.connectionState === "connected") {
          void this.activate(resources, transceiver.sender);
        }
      };
      resources.off = this.api.onNativeVoiceEvent((event) => {
        if (event.sessionId !== resources.id || !this.current(resources)) return;
        this.onEvent(resources, event, transceiver.sender);
      });
      resources.timer = setTimeout(() => this.fail(resources, new Error("Voice did not connect within 25 seconds. Check Codex access and try again.")), 25_000);
      await peer.setLocalDescription(await peer.createOffer());
      // Include gathered candidates in the single SDP exchange; there is no
      // trickle-ICE RPC in the Codex protocol.
      await this.gatherIce(resources);
      if (!this.current(resources)) return;
      await this.api.startNativeVoice({ threadId, sessionId: resources.id, sdp: peer.localDescription!.sdp, mode });
      if (!this.current(resources)) return;
      resources.accepted = true;
      await this.activate(resources, transceiver.sender);
    } catch (error) {
      this.fail(resources, error);
    }
  }

  private gatherIce(resources: Resources): Promise<void> {
    const peer = resources.peer!;
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        peer.removeEventListener("icegatheringstatechange", changed);
        resources.finishIce = undefined;
        resolve();
      };
      const changed = () => { if (peer.iceGatheringState === "complete") finish(); };
      const timer = setTimeout(finish, 1500);
      resources.finishIce = finish;
      peer.addEventListener("icegatheringstatechange", changed);
    });
  }

  private onEvent(resources: Resources, event: NativeVoiceEvent, sender: RTCRtpSender): void {
    switch (event.type) {
      case "sdp":
        void resources.peer!.setRemoteDescription({ type: "answer", sdp: event.sdp }).catch((error: unknown) => this.fail(resources, error));
        break;
      case "started":
        resources.started = true;
        void this.activate(resources, sender);
        break;
      case "transcript": {
        const transcript = [...this.view.transcript];
        const openSeq = this.openRows.get(event.role);
        const index = openSeq === undefined ? -1 : transcript.findIndex((row) => row.seq === openSeq);
        if (index >= 0) {
          const row = transcript[index]!;
          transcript[index] = { ...row, text: event.done ? event.text : row.text + event.text };
        } else {
          const seq = ++this.seq;
          transcript.push({ role: event.role, text: event.text, seq });
          if (!event.done) this.openRows.set(event.role, seq);
        }
        if (event.done) this.openRows.delete(event.role);
        // Voice text is memory-only, bounded and discarded on the next session.
        this.publish({ transcript: transcript.slice(-MAX_TRANSCRIPT_ROWS).map((row) => ({ ...row, text: row.text.slice(-8000) })) });
        this.armMutedIdleEnd(resources);
        break;
      }
      case "action": {
        const { type: _type, sessionId: _sessionId, ...action } = event;
        this.publish({ actions: [...this.view.actions, { ...action, seq: ++this.seq }].slice(-MAX_ACTION_ROWS) });
        this.armMutedIdleEnd(resources);
        break;
      }
      case "error":
        this.fail(resources, new Error(event.message));
        break;
      case "closed":
        if (event.reason) this.fail(resources, new Error(event.reason));
        else void this.stop();
        break;
    }
  }

  private async activate(resources: Resources, sender: RTCRtpSender): Promise<void> {
    if (!this.current(resources) || resources.activating || !resources.started || !resources.accepted
      || resources.peer?.connectionState !== "connected") return;
    resources.activating = true;
    try {
      // Capture starts only after explicit opt-in and successful negotiation.
      const stream = await this.platform.microphone();
      if (!this.current(resources)) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      resources.stream = stream;
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("No microphone audio track is available.");
      track.onended = () => this.fail(resources, new Error("Microphone disconnected."));
      await sender.replaceTrack(track);
      try { resources.meter = this.platform.meter?.(stream); } catch { resources.meter = undefined; }
      if (!this.current(resources)) return;
      clearTimeout(resources.timer);
      this.publish({ status: "listening", liveSince: Date.now() });
    } catch (error) { this.fail(resources, error); }
  }

  private fail(resources: Resources, error: unknown): void {
    if (!this.current(resources)) return;
    const message = error instanceof Error ? error.message : "Voice failed.";
    this.publish({ status: "error", error: message });
    void this.stop(true);
  }

  stop(preserveError = false): Promise<void> {
    const resources = this.resources;
    if (!resources) return Promise.resolve();
    if (resources.stop) return resources.stop;
    this.closeCamera(resources);
    resources.cancelled = true;
    clearTimeout(resources.timer);
    clearTimeout(resources.idleTimer);
    resources.finishIce?.();
    resources.off?.();
    resources.offTurns?.();
    if (resources.peer) {
      resources.peer.ontrack = null;
      resources.peer.onconnectionstatechange = null;
      resources.peer.close();
    }
    for (const track of resources.stream?.getTracks() ?? []) { track.onended = null; track.stop(); }
    resources.meter?.close();
    resources.meter = undefined;
    if (resources.audio) {
      resources.audio.pause();
      const remote = resources.audio.srcObject;
      if (remote instanceof MediaStream) for (const track of remote.getTracks()) track.stop();
      resources.audio.srcObject = null;
      resources.audio.removeAttribute("src");
    }
    if (!preserveError) this.publish({ status: "stopping" });
    let stopped = false;
    resources.stop = this.api.stopNativeVoice({ sessionId: resources.id }).then(() => {
      stopped = true;
    }).catch((error: unknown) => {
      this.publish({ status: "stop-error", error: error instanceof Error ? error.message : "Could not end voice. Try End voice again." });
    }).finally(() => {
      if (stopped) {
        if (this.resources === resources) this.resources = undefined;
        if (!preserveError && this.view.status !== "error") this.publish({ status: "idle", muted: false });
      } else resources.stop = undefined;
    });
    return resources.stop;
  }

  dismissCameraError(): void { this.publish({ cameraError: undefined }); }

  cameraStream(): MediaStream | undefined { return this.resources?.camera?.capture?.stream; }

  private closeCamera(resources: Resources): void {
    const camera = resources.camera;
    if (!camera) return;
    camera.cancelled = true;
    clearTimeout(camera.timer);
    camera.capture?.close();
    resources.camera = undefined;
    this.publish({ camera: undefined, cameraCue: undefined, cameraWarming: undefined });
    void this.api.setNativeVoiceCamera?.({ sessionId: resources.id, enabled: false }).catch(() => undefined);
  }

  async setCamera(enabled: boolean): Promise<void> {
    const resources = this.resources;
    if (!resources || this.view.status !== "listening") return;
    if (!enabled) { this.closeCamera(resources); return; }
    if (resources.camera) return;
    if (!this.api.setNativeVoiceCamera || !this.api.analyzeNativeVoiceCamera || !this.api.sendNativeVoiceCameraCue || !this.platform.camera) {
      this.publish({ cameraError: "Camera cues are unavailable in this window." });
      return;
    }
    const camera: NonNullable<Resources["camera"]> = { cancelled: false };
    resources.camera = camera;
    const current = () => this.current(resources) && resources.camera === camera && !camera.cancelled;
    const filter = new CameraCueFilter();
    const completed: number[] = [];
    let diagnostics: VoiceCameraDiagnostics = {
      sessionId: resources.id, threadId: this.view.threadId!, startedAt: Date.now(),
      observations: 0, staleObservations: 0, rateHz: 0, cuesAcknowledged: 0, filter: "Waiting for first decision",
    };
    const debug = (change: Partial<VoiceCameraDiagnostics>) => {
      diagnostics = { ...diagnostics, ...change };
      this.publish({ cameraDiagnostics: diagnostics });
    };
    this.publish({ camera: "starting", cameraError: undefined, cameraDiagnostics: diagnostics });
    const failed = (error: unknown) => {
      if (!current()) return;
      debug({ error: cameraErrorText(error), filter: "Camera stopped after failure" });
      this.closeCamera(resources);
      this.publish({ cameraError: cameraErrorText(error) });
    };
    let skipStreak = 0;
    try {
      await this.api.setNativeVoiceCamera({ sessionId: resources.id, enabled: true });
      if (!current()) return;
      const capture = await this.platform.camera();
      if (!current()) { capture.close(); return; }
      camera.capture = capture;
      this.publish({ camera: "on", cameraWarming: true });
      const sample = async () => {
        if (!current()) return;
        const started = Date.now();
        try {
          const image = capture.frame();
          if (image) {
            const observation = await this.api.analyzeNativeVoiceCamera!({ sessionId: resources.id, image });
            if (!current()) return;
            if (!observation) {
              this.closeCamera(resources);
              debug({ filter: "Analysis cancelled" });
              return;
            }
            if ("skipped" in observation) {
              // Skipped frames break continuity: they never count toward a
              // gesture, and never as the operator being away.
              // Main paces a skip that reached no model; otherwise back off.
              if (observation.retryAfterMs === undefined) skipStreak += 1;
              filter.resetContinuity();
              debug({
                skipped: observation.skipped, skippedFrames: (diagnostics.skippedFrames ?? 0) + 1, inFlight: observation.inFlight,
                filter: observation.skipped === "busy" ? "Clef busy; retrying" : "Clef unavailable; retrying",
              });
              const retryMs = observation.retryAfterMs
                ?? Math.min(CAMERA_SKIP_RETRY_MAX_MS, CAMERA_SKIP_RETRY_MS * 2 ** (skipStreak - 1));
              camera.timer = setTimeout(() => { void sample(); }, retryMs);
              return;
            }
            skipStreak = 0;
            if (this.view.cameraWarming) this.publish({ cameraWarming: false });
            // A cold-model response describes the old captured frame. Waiting
            // never establishes absence or permits a stale expression cue.
            const now = Date.now();
            completed.push(now);
            while (completed.length > 1 && now - completed[0] > 10_000) completed.shift();
            const interval = now - completed[0];
            debug({
              skipped: undefined, inFlight: undefined, observations: diagnostics.observations + 1, observation, lastObservedAt: now, frameAgeMs: now - started,
              rateHz: interval > 0 ? (completed.length - 1) * 1000 / interval : 0,
            });
            if (now - started > CAMERA_SAMPLE_GAP_MS) {
              debug({ staleObservations: diagnostics.staleObservations + 1, filter: "Stale frame discarded; waiting for a fresh decision" });
              filter.resetContinuity();
              if (current()) camera.timer = setTimeout(() => { void sample(); }, 500);
              return;
            }
            const decision = filter.observe(observation, now);
            debug({ filter: observation.gesture ? `${filter.status}; gesture: ${filter.gestureStatus}` : filter.status });
            if (decision.end) {
              this.publish({ endedAfterAway: true });
              void this.stop();
              return;
            }
            if (decision.cue) {
              // A gesture or a change in presence is something the operator
              // did, so it earns a transcript row; a vibe is ambient and is
              // only shown live, in the dock.
              const receipt = isTranscriptCue(decision.cue);
              const seq = receipt ? ++this.seq : undefined;
              const delivered = (delivery: VoiceCameraCueRow["delivery"]) => {
                if (seq === undefined) return;
                this.publish({ cameraCues: (this.view.cameraCues ?? []).map((row) => row.seq === seq ? { ...row, delivery } : row) });
              };
              this.publish({
                cameraCue: decision.cue,
                ...(seq === undefined ? {} : {
                  cameraCues: [...(this.view.cameraCues ?? []), { cue: decision.cue, seq, delivery: "pending" as const }].slice(-MAX_ACTION_ROWS),
                }),
              });
              debug({ lastCue: decision.cue, delivery: "pending" });
              // Do not reset muted-idle timers: a camera cue is not user activity.
              // The receipt settles even if the camera stopped meanwhile: the
              // transcript outlives the camera, and "sending…" must not stick.
              try {
                await this.api.sendNativeVoiceCameraCue!({ sessionId: resources.id, cue: decision.cue });
                delivered("acknowledged");
                if (!current()) return;
                debug({ delivery: "acknowledged", acknowledgedAt: Date.now(), cuesAcknowledged: diagnostics.cuesAcknowledged + 1 });
              } catch (error) {
                delivered("failed");
                if (current()) debug({ delivery: "failed" });
                throw error;
              }
            }
          }
          if (current()) camera.timer = setTimeout(() => { void sample(); }, Math.max(0, 500 - (Date.now() - started)));
        } catch (error) { failed(error); }
      };
      void sample();
    } catch (error) { failed(error); }
  }

  async text(text: string): Promise<void> {
    const resources = this.resources;
    if (!resources || this.view.status !== "listening") return;
    try { await this.api.sendNativeVoiceText({ sessionId: resources.id, text }); }
    catch (error) { this.fail(resources, error); }
    // A typed message is the operator still talking, even while muted.
    this.armMutedIdleEnd(resources);
  }
}

// This module is window-local. Keep the session token after a composer unmount
// until main acknowledges stop, even if the next composer receives a new API
// wrapper. No microphone or backend session is created by acquiring this owner.
let windowController: NativeVoiceController | undefined;
let windowApi: NativeVoiceApi | undefined;
export function getWindowNativeVoiceController(api: NativeVoiceApi): NativeVoiceController {
  if (!windowController) {
    window.addEventListener("pagehide", () => { void windowController?.stop(); });
  }
  if (!windowController || (windowApi !== api && !windowController.hasSession())) {
    windowController = new NativeVoiceController(api);
    windowApi = api;
  }
  return windowController;
}
