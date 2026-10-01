import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FormEvent } from "react";
import type { NativeVoiceApi, NativeVoiceCapability } from "../../../../../shared/native-voice";
import { NativeVoiceBar, NativeVoiceToggle } from "../NativeVoice";
import { OverseerVoiceHud, toggleOverseerVoice } from "../OverseerVoice";
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
  const track = { stop: vi.fn(), onended: null, enabled: true };
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
    openVoiceManager: vi.fn(async () => ({ status: "ready" as const, threadId: "sample-voice-manager", created: false })),
  };
  const owner = getWindowNativeVoiceController(api);
  owners.add(owner);
  const emit = (event: NativeVoiceEvent) => { act(() => { for (const listener of listeners) listener(event); }); };
  return { api, owner, capture, peer, track, listeners, emit };
}

function Composer({ api, threadId }: { api: NativeVoiceApi; threadId?: string }) {
  return <><NativeVoiceBar api={api} threadId={threadId} /><NativeVoiceToggle api={api} threadId={threadId} /></>;
}

async function openTranscript() {
  fireEvent.click(await screen.findByRole("button", { name: "Transcript" }));
  return await screen.findByRole("textbox", { name: "Message voice" });
}

it("adds nothing beside the coding status until the operator opts in", async () => {
  let resolveCapability!: (value: NativeVoiceCapability) => void;
  const capability = new Promise<NativeVoiceCapability>((resolve) => { resolveCapability = resolve; });
  const api: NativeVoiceApi = {
    nativeVoiceCapability: vi.fn(() => capability),
    startNativeVoice: vi.fn(async () => {}),
    stopNativeVoice: vi.fn(async () => {}),
    sendNativeVoiceText: vi.fn(async () => {}),
    onNativeVoiceEvent: vi.fn(() => () => {}),
  };
  render(<><div role="status">Thinking</div><Composer api={api} threadId="sample-thread" /></>);
  owners.add(getWindowNativeVoiceController(api));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.queryByRole("region", { name: "Thread voice" })).not.toBeInTheDocument();
  expect(api.nativeVoiceCapability).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  expect(await screen.findByRole("status", { name: "Voice status" })).toHaveTextContent("Checking voice access");
  resolveCapability({ available: false, reason: "Unsupported sample runtime." });
  expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported sample runtime.");
  expect(api.startNativeVoice).not.toHaveBeenCalled();
  await waitFor(() => expect(getWindowNativeVoiceController(api).hasSession()).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("region", { name: "Thread voice" })).not.toBeInTheDocument();
});

it("starts thread voice from the composer toggle and shows the microphone as live", async () => {
  const f = voiceFixture();
  render(<Composer api={f.api} threadId="sample-thread" />);
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  await waitFor(() => expect(screen.getByRole("status", { name: "Voice status" })).toHaveTextContent("Microphone live"));
  expect(screen.getByRole("status", { name: "Voice status" })).toHaveClass("native-voice__status--live");
  expect(screen.getByRole("button", { name: "Voice" })).toHaveAttribute("aria-pressed", "true");
  expect(vi.mocked(f.api.startNativeVoice).mock.calls[0][0]).toMatchObject({ threadId: "sample-thread", mode: "thread" });

  fireEvent.click(screen.getByRole("button", { name: "Mute" }));
  expect(f.track.enabled).toBe(false);
  expect(screen.getByRole("status", { name: "Voice status" })).toHaveTextContent("Microphone muted");
  fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
  expect(f.track.enabled).toBe(true);
});

it("sends voice text by click and Enter without submitting or changing the coding draft", async () => {
  const f = voiceFixture();
  const submitCoding = vi.fn((event: FormEvent) => event.preventDefault());
  const codingKeys = vi.fn();
  render(<form onSubmit={submitCoding} onKeyDown={codingKeys}>
    <input aria-label="Coding draft" defaultValue="Sample unsent coding task" />
    <Composer api={f.api} threadId="sample-thread" />
  </form>);
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  const input = await openTranscript();
  expect(document.querySelectorAll("form")).toHaveLength(1);
  fireEvent.change(input, { target: { value: "Sample voice message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to voice" }));
  fireEvent.change(input, { target: { value: "Another voice message" } });
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
  expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(false);
  expect(f.api.sendNativeVoiceText).toHaveBeenCalledTimes(2);
  expect(submitCoding).not.toHaveBeenCalled();
  expect(codingKeys).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Coding draft" })).toHaveValue("Sample unsent coding task");
});

it("retains a failed stop across unmount and exposes retry on a non-Codex composer", async () => {
  const f = voiceFixture();
  vi.mocked(f.api.stopNativeVoice).mockRejectedValueOnce(new Error("Sample backend stop failed."));
  const mounted = render(<Composer api={f.api} threadId="sample-first-thread" />);
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
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
  const next = render(<Composer api={nextApi} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Sample backend stop failed.");
  expect(screen.queryByRole("button", { name: "Voice" })).not.toBeInTheDocument();
  expect(f.capture).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "End voice" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "End voice" })).not.toBeInTheDocument());
  expect(f.api.stopNativeVoice).toHaveBeenNthCalledWith(1, { sessionId });
  expect(f.api.stopNativeVoice).toHaveBeenNthCalledWith(2, { sessionId });
  expect(f.owner.hasSession()).toBe(false);
  next.rerender(<Composer api={nextApi} threadId="sample-next-thread" />);
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  await waitFor(() => expect(f.api.startNativeVoice).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.api.startNativeVoice).mock.calls[1][0].threadId).toBe("sample-next-thread");
  expect(vi.mocked(f.api.startNativeVoice).mock.calls[1][0].sessionId).not.toBe(sessionId);
});

it("keeps overseer voice through navigation and shows what its tools did", async () => {
  const f = voiceFixture();
  const composer = render(<Composer api={f.api} threadId="sample-first-thread" />);
  render(<OverseerVoiceHud api={f.api} focus={{ id: "sample-first-thread", source: "codex", title: "Sample first thread" }} />);
  await act(async () => { await toggleOverseerVoice(f.api, f.owner); });
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  expect(vi.mocked(f.api.startNativeVoice).mock.calls[0][0]).toMatchObject({ threadId: "sample-voice-manager", mode: "overseer" });
  const hud = screen.getByRole("region", { name: "Overseer voice" });
  expect(hud).toHaveTextContent("Looking at Sample first thread");

  // The composer's toggle cannot start a second session, and leaving the
  // thread does not end overseer voice.
  expect(screen.getByRole("button", { name: "Voice" })).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  composer.rerender(<Composer api={f.api} threadId="sample-second-thread" />);
  composer.unmount();
  expect(f.api.stopNativeVoice).not.toHaveBeenCalled();
  expect(f.api.startNativeVoice).toHaveBeenCalledOnce();

  const sessionId = vi.mocked(f.api.startNativeVoice).mock.calls[0][0].sessionId;
  f.emit({ sessionId, type: "transcript", role: "user", text: "Tell the sample thread to rerun its checks.", done: true });
  f.emit({ sessionId, type: "action", tool: "send_message_to_thread", ok: true, target: "Sample second thread", outcome: "queued" });
  f.emit({ sessionId, type: "action", tool: "stop_thread", ok: false });
  const feed = screen.getByRole("log", { name: "Voice transcript" });
  expect(feed).toHaveTextContent("You: Tell the sample thread to rerun its checks.");
  expect(feed).toHaveTextContent("send_message_to_threadSample second threadqueued");
  expect(feed).toHaveTextContent("stop_threadfailed");

  await act(async () => { await toggleOverseerVoice(f.api, f.owner); });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Overseer voice" })).not.toBeInTheDocument());
});

it("reports a Voice manager that cannot be opened instead of starting voice", async () => {
  const f = voiceFixture();
  vi.mocked(f.api.openVoiceManager!).mockResolvedValueOnce({ status: "failed", error: "Sample manager failure." });
  render(<OverseerVoiceHud api={f.api} />);
  await act(async () => { await toggleOverseerVoice(f.api, f.owner); });
  expect(screen.getByRole("alert")).toHaveTextContent("Sample manager failure.");
  expect(f.api.startNativeVoice).not.toHaveBeenCalled();
  expect(f.capture).not.toHaveBeenCalled();
});
