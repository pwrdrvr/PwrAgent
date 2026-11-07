import { mediaDevices, RTCPeerConnection, RTCSessionDescription, type MediaStream } from "react-native-webrtc";
import * as Crypto from "expo-crypto";
import type { MobileEvent } from "../../../packages/shared/src/mobile-gateway";
import type { Gateway } from "./gateway";

/** Signaling and tool authority stay on the gateway; WebRTC carries media.
 * No OpenAI token or vendor REST endpoint exists in the phone application. */
export class LiveVoice {
  private peer?: RTCPeerConnection;
  private microphone?: MediaStream;
  private sessionId?: string;
  private cancelled = false;
  private generation = 0;
  onStatus: (status: string) => void = () => {};
  onText: (text: string) => void = () => {};
  constructor(private readonly gateway: Gateway, private readonly uuid = Crypto.randomUUID) {}
  async start(): Promise<void> {
    if (this.sessionId) return;
    const generation = ++this.generation;
    this.cancelled = false;
    this.onStatus("Connecting Live");
    const sessionId = this.uuid(); this.sessionId = sessionId;
    try {
      const microphone = await mediaDevices.getUserMedia({ audio: true, video: false });
      if (generation !== this.generation) { microphone.getTracks().forEach((track) => track.stop()); return; }
      this.microphone = microphone;
      const peer = new RTCPeerConnection({}); this.peer = peer;
      microphone.getTracks().forEach((track) => peer.addTrack(track, microphone));
      peer.createDataChannel("oai-events");
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") this.onStatus("Live");
        if (["failed", "disconnected", "closed"].includes(peer.connectionState) && !this.cancelled) void this.stop();
      };
      const offer = await peer.createOffer({});
      await peer.setLocalDescription(offer);
      if (generation !== this.generation) return;
      await this.gateway.rpc("voice.start", { sessionId, sdp: offer.sdp });
      if (generation !== this.generation) await this.gateway.rpc("voice.stop", { sessionId });
    } catch (error) {
      if (generation !== this.generation) return;
      await this.stop();
      this.onStatus(error instanceof Error ? error.message : "Live unavailable");
    }
  }
  event(event: MobileEvent): void {
    if (event.event !== "voice" || event.data.sessionId !== this.sessionId) return;
    const data = event.data;
    if (data.type === "sdp" && data.sdp) {
      void this.peer?.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: data.sdp })).catch(() => this.stop());
    }
    if (data.type === "transcript" && data.text) this.onText(data.text);
    if (data.type === "action") this.onText(`${data.tool}: ${data.ok ? "done" : "failed"}${data.target ? ` · ${data.target}` : ""}`);
    if (data.type === "error" || data.type === "closed") { void this.stop(); this.onStatus(data.message ?? data.reason ?? "Live ended"); }
  }
  async stop(): Promise<void> {
    ++this.generation;
    this.cancelled = true;
    const sessionId = this.sessionId; this.sessionId = undefined;
    this.microphone?.getTracks().forEach((track) => track.stop()); this.microphone = undefined;
    this.peer?.close(); this.peer = undefined; this.onStatus("Live off");
    if (sessionId) await this.gateway.rpc("voice.stop", { sessionId }).catch(() => undefined);
  }
}
