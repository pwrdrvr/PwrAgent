import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FormEvent } from "react";
import type { NativeVoiceApi, NativeVoiceCapability } from "../../../../../shared/native-voice";
import { NativeVoice } from "../NativeVoice";
import { getWindowNativeVoiceController, type NativeVoiceController } from "../native-voice-controller";
import type { NativeVoiceEvent } from "../../../../../shared/native-voice";

const owners = new Set<NativeVoiceController>();
afterEach(async () => {
  cleanup();
  for (const owner of owners) await owner.stop();
  owners.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function voiceFixture() {
  const listeners = new Set<(event: NativeVoiceEvent) => void>();
  const track = { stop: vi.fn(), onended: null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const capture = vi.fn(async () => stream);
  const peer = {
    connectionState: "connected", iceGatheringState: "complete", localDescription: { sdp: "v=0\r\nsample" },
    addTransceiver: () => ({ sender: { replaceTrack: vi.fn(async () => {}) } }), createDataChannel: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0\r\nsample" })),
    setLocalDescription: vi.fn(async () => {}), close: vi.fn(), ontrack: null, onconnectionstatechange: null,
  };
  const audio = { srcObject: null, pause: vi.fn(), removeAttribute: vi.fn(), autoplay: false };
  vi.stubGlobal("MediaStream", class MediaStream {});
  vi.stubGlobal("RTCPeerConnection", class Peer { constructor() { return peer; } });
  vi.stubGlobal("Audio", class Audio { constructor() { return audio; } });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
  const api: NativeVoiceApi = {
    nativeVoiceCapability: vi.fn(async () => ({ available: true })),
    startNativeVoice: vi.fn(async (request) => {
      for (const listener of listeners) listener({ type: "started", version: "v3", sessionId: request.sessionId });
    }),
    stopNativeVoice: vi.fn(async () => {}), sendNativeVoiceText: vi.fn(async () => {}),
    onNativeVoiceEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const owner = getWindowNativeVoiceController(api);
  owners.add(owner);
  return { api, owner, capture, peer, track, listeners };
}

it("keeps the idle hint separate from coding status and announces opted-in voice state", async () => {
  let resolveCapability!: (value: NativeVoiceCapability) => void;
  const capability = new Promise<NativeVoiceCapability>((resolve) => { resolveCapability = resolve; });
  const api: NativeVoiceApi = {
    nativeVoiceCapability: vi.fn(() => capability),
    startNativeVoice: vi.fn(async () => {}),
    stopNativeVoice: vi.fn(async () => {}),
    sendNativeVoiceText: vi.fn(async () => {}),
    onNativeVoiceEvent: vi.fn(() => () => {}),
  };
  render(<><div role="status">Thinking</div><NativeVoice api={api} threadId="sample-thread" /></>);
  owners.add(getWindowNativeVoiceController(api));
  expect(screen.getByRole("status")).toHaveTextContent("Thinking");
  expect(screen.getByText("Experimental · opt in to talk")).not.toHaveAttribute("role");
  expect(api.nativeVoiceCapability).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
  expect(await screen.findByRole("status", { name: "Voice status" })).toHaveTextContent("Checking voice access");
  resolveCapability({ available: false, reason: "Unsupported sample runtime." });
  expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported sample runtime.");
  expect(api.startNativeVoice).not.toHaveBeenCalled();
});

it("sends voice text by click and Enter without submitting or changing the coding draft", async () => {
  const f = voiceFixture();
  const submitCoding = vi.fn((event: FormEvent) => event.preventDefault());
  const codingKeys = vi.fn();
  render(<form onSubmit={submitCoding} onKeyDown={codingKeys}>
    <input aria-label="Coding draft" defaultValue="Sample unsent coding task" />
    <NativeVoice api={f.api} threadId="sample-thread" />
  </form>);
  fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
  await screen.findByRole("textbox", { name: "Message voice" });
  expect(document.querySelectorAll("form")).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox", { name: "Message voice" }), { target: { value: "Sample voice message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to voice" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Message voice" }), { target: { value: "Another voice message" } });
  expect(fireEvent.keyDown(screen.getByRole("textbox", { name: "Message voice" }), { key: "Enter" })).toBe(false);
  expect(fireEvent.keyDown(screen.getByRole("textbox", { name: "Message voice" }), { key: "Enter", isComposing: true })).toBe(false);
  expect(f.api.sendNativeVoiceText).toHaveBeenCalledTimes(2);
  expect(submitCoding).not.toHaveBeenCalled();
  expect(codingKeys).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Coding draft" })).toHaveValue("Sample unsent coding task");
});

it("retains a failed stop across unmount and exposes retry on a non-Codex composer", async () => {
  const f = voiceFixture();
  vi.mocked(f.api.stopNativeVoice).mockRejectedValueOnce(new Error("Sample backend stop failed."));
  const mounted = render(<NativeVoice api={f.api} threadId="sample-first-thread" />);
  fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
  await screen.findByRole("textbox", { name: "Message voice" });
  const sessionId = vi.mocked(f.api.startNativeVoice).mock.calls[0][0].sessionId;
  mounted.unmount();
  await waitFor(() => expect(f.owner.getView().status).toBe("stop-error"));
  expect(f.track.stop).toHaveBeenCalled();
  expect(f.peer.close).toHaveBeenCalled();
  expect(f.listeners.size).toBe(0);

  // A replacement API wrapper and a thread without Codex both retain the
  // window owner. Retry targets the original token, never a fresh session.
  const nextApi = { ...f.api };
  expect(getWindowNativeVoiceController(nextApi)).toBe(f.owner);
  const next = render(<NativeVoice api={nextApi} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Sample backend stop failed.");
  expect(f.capture).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Stop voice" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop voice" })).not.toBeInTheDocument());
  expect(f.api.stopNativeVoice).toHaveBeenNthCalledWith(1, { sessionId });
  expect(f.api.stopNativeVoice).toHaveBeenNthCalledWith(2, { sessionId });
  expect(f.owner.hasSession()).toBe(false);
  next.rerender(<NativeVoice api={nextApi} threadId="sample-next-thread" />);
  fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
  await screen.findByRole("textbox", { name: "Message voice" });
  expect(f.api.startNativeVoice).toHaveBeenCalledTimes(2);
  expect(vi.mocked(f.api.startNativeVoice).mock.calls[1][0].threadId).toBe("sample-next-thread");
  expect(vi.mocked(f.api.startNativeVoice).mock.calls[1][0].sessionId).not.toBe(sessionId);
});
