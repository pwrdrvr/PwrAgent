import type { NativeVoiceApi, NativeVoiceEvent } from "../../../../shared/native-voice";

export type VoiceStatus = "idle" | "checking" | "connecting" | "listening" | "stopping" | "stop-error" | "error";
export type VoiceView = { status: VoiceStatus; error?: string; transcript: Array<{ role: string; text: string }> };
type Resources = {
  id: string;
  peer?: RTCPeerConnection;
  stream?: MediaStream;
  audio?: HTMLAudioElement;
  off?: () => void;
  timer?: ReturnType<typeof setTimeout>;
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
};
const browser: VoiceBrowser = {
  peer: () => new RTCPeerConnection(),
  audio: () => new Audio(),
  microphone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }),
  id: () => crypto.randomUUID(),
};

/** Owns every track, peer, audio element and listener for one composer. */
export class NativeVoiceController {
  private resources?: Resources;
  private view: VoiceView = { status: "idle", transcript: [] };
  private partialRole?: string;
  constructor(
    private readonly api: NativeVoiceApi,
    private readonly update: (view: VoiceView) => void,
    private readonly platform: VoiceBrowser = browser,
  ) {}

  private publish(change: Partial<VoiceView>): void {
    this.view = { ...this.view, ...change };
    this.update(this.view);
  }
  private current(resources: Resources): boolean {
    return this.resources === resources && !resources.cancelled;
  }

  async start(threadId: string): Promise<void> {
    if (this.resources) return;
    const resources: Resources = { id: this.platform.id(), started: false, accepted: false, activating: false, cancelled: false };
    this.resources = resources;
    this.partialRole = undefined;
    this.publish({ status: "checking", error: undefined, transcript: [] });
    try {
      const capability = await this.api.nativeVoiceCapability();
      if (!this.current(resources)) return;
      if (!capability.available) throw new Error(capability.reason ?? "Live voice is unavailable.");
      this.publish({ status: "connecting" });
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
      await this.api.startNativeVoice({ threadId, sessionId: resources.id, sdp: peer.localDescription!.sdp });
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
        if (this.partialRole === event.role && transcript.length) {
          const last = transcript[transcript.length - 1];
          transcript[transcript.length - 1] = { role: event.role, text: event.done ? event.text : last.text + event.text };
        } else {
          transcript.push({ role: event.role, text: event.text });
        }
        this.partialRole = event.done ? undefined : event.role;
        // Voice text is memory-only, bounded and discarded on the next session.
        this.publish({ transcript: transcript.slice(-40).map((row) => ({ ...row, text: row.text.slice(-8000) })) });
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
      if (!this.current(resources)) return;
      clearTimeout(resources.timer);
      this.publish({ status: "listening" });
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
    resources.cancelled = true;
    clearTimeout(resources.timer);
    resources.finishIce?.();
    resources.off?.();
    if (resources.peer) {
      resources.peer.ontrack = null;
      resources.peer.onconnectionstatechange = null;
      resources.peer.close();
    }
    for (const track of resources.stream?.getTracks() ?? []) { track.onended = null; track.stop(); }
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
      this.publish({ status: "stop-error", error: error instanceof Error ? error.message : "Could not stop voice. Try Stop voice again." });
    }).finally(() => {
      if (stopped) {
        if (this.resources === resources) this.resources = undefined;
        if (!preserveError && this.view.status !== "error") this.publish({ status: "idle" });
      } else resources.stop = undefined;
    });
    return resources.stop;
  }

  async text(text: string): Promise<void> {
    const resources = this.resources;
    if (!resources || this.view.status !== "listening") return;
    try { await this.api.sendNativeVoiceText({ sessionId: resources.id, text }); }
    catch (error) { this.fail(resources, error); }
  }
}
