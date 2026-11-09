import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ stopTrack: vi.fn(), closePeer: vi.fn(), setRemote: vi.fn(async () => {}), permission: vi.fn<() => Promise<{ getTracks(): Array<{ stop: () => void }> }>>() }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "session-1" }));
vi.mock("react-native-webrtc", () => ({
  mediaDevices: { getUserMedia: fixture.permission },
  RTCPeerConnection: class {
    connectionState = "new";
    addTrack() {}
    createDataChannel() {}
    createOffer = async () => ({ type: "offer", sdp: "v=0\r\nfixture-offer" });
    setLocalDescription = async () => {};
    setRemoteDescription = fixture.setRemote;
    close = fixture.closePeer;
  },
  RTCSessionDescription: class { constructor(readonly value: unknown) {} },
}));
import { LiveVoice } from "./live";
import type { Gateway } from "./gateway";
beforeEach(() => {
  vi.clearAllMocks();
  fixture.permission.mockResolvedValue({ getTracks: () => [{ stop: fixture.stopTrack }] });
});
it("negotiates audio through gateway signaling and releases microphone on stop", async () => {
  const rpc = vi.fn(async () => ({})); const live = new LiveVoice({ rpc } as unknown as Gateway);
  await live.start();
  expect(fixture.permission).toHaveBeenCalledWith({ audio: true, video: false });
  expect(rpc).toHaveBeenCalledWith("voice.start", { sessionId: "session-1", sdp: "v=0\r\nfixture-offer" });
  live.event({ event: "voice", data: { type: "sdp", sessionId: "session-1", sdp: "v=0\r\nanswer" } });
  expect(fixture.setRemote).toHaveBeenCalledOnce();
  await live.stop(); expect(fixture.stopTrack).toHaveBeenCalledOnce(); expect(fixture.closePeer).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenLastCalledWith("voice.stop", { sessionId: "session-1" });
});
it("cancellation during microphone permission cannot start a late billed session", async () => {
  let allow: (stream: { getTracks(): Array<{ stop: () => void }> }) => void = () => {};
  fixture.permission.mockReturnValue(new Promise((resolve) => { allow = resolve; }));
  const rpc = vi.fn(async () => ({})); const live = new LiveVoice({ rpc } as unknown as Gateway);
  const starting = live.start(); await live.stop(); allow({ getTracks: () => [{ stop: fixture.stopTrack }] }); await starting;
  expect(rpc.mock.calls.some((call) => (call as unknown[])[0] === "voice.start")).toBe(false);
  expect(fixture.stopTrack).toHaveBeenCalledOnce();
});
