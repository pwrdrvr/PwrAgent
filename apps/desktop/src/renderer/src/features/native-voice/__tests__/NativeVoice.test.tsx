import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCallback, useState, type FormEvent } from "react";
import type { NativeVoiceApi, NativeVoiceCapability } from "../../../../../shared/native-voice";
import { NativeVoiceBar, NativeVoiceToggle, threadVoiceTarget, useNativeVoiceNotices } from "../NativeVoice";
import { DirectorVoiceComposerToggle, DirectorVoiceToast, operatorFocusFor, toggleDirectorVoice } from "../DirectorVoice";
import { AppNoticeToast, type AppNoticeToastNotice } from "../../notifications/AppNoticeToast";
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

/** The app's notice stack in miniature: voice raises notices, the library draws them. */
function Notices({ api }: { api: NativeVoiceApi }) {
  const [notices, setNotices] = useState<AppNoticeToastNotice[]>([]);
  const show = useCallback((notice: AppNoticeToastNotice) => {
    setNotices((current) => [...current.filter((item) => item.id !== notice.id), notice]);
  }, []);
  const dismiss = useCallback((id: string) => {
    setNotices((current) => current.filter((item) => item.id !== id));
  }, []);
  useNativeVoiceNotices(api, show, dismiss);
  return <>{notices.map((notice) => <AppNoticeToast key={notice.id} notice={notice} onDismiss={() => dismiss(notice.id)} />)}</>;
}

const noticeCard = (id: string) => document.querySelector(`[data-notice-id="${id}"]`);

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
  render(<><div role="status">Thinking</div><Composer api={api} threadId="sample-thread" /><Notices api={api} /></>);
  owners.add(getWindowNativeVoiceController(api));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.queryByRole("region", { name: "Thread voice" })).not.toBeInTheDocument();
  expect(api.nativeVoiceCapability).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  expect(await screen.findByRole("status", { name: "Voice status" })).toHaveTextContent("Checking voice access");
  resolveCapability({ available: false, reason: "Unsupported sample runtime." });
  // The failure is an ordinary notice with the library's own close button;
  // the voice bar steps aside rather than growing a Dismiss of its own.
  await waitFor(() => expect(noticeCard("native-voice-error")).toHaveTextContent("Unsupported sample runtime."));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread voice" })).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  expect(api.startNativeVoice).not.toHaveBeenCalled();
  expect(getWindowNativeVoiceController(api).hasSession()).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
  expect(noticeCard("native-voice-error")).toBeNull();
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

it("keeps director voice through navigation and shows what its tools did", async () => {
  const f = voiceFixture();
  const composer = render(<Composer api={f.api} threadId="sample-first-thread" />);
  render(<DirectorVoiceToast api={f.api} focus={{ id: "sample-first-thread", source: "codex", title: "Sample first thread" }} />);
  await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  expect(vi.mocked(f.api.startNativeVoice).mock.calls[0][0]).toMatchObject({ threadId: "sample-voice-manager", mode: "director" });
  expect(noticeCard("director-voice")).toHaveTextContent("Looking at Sample first thread");

  // The composer's toggle cannot start a second session, and leaving the
  // thread does not end director voice.
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

  // The notice card's own close button ends the session, and says so.
  fireEvent.click(screen.getByRole("button", { name: "End director voice" }));
  await waitFor(() => expect(f.api.stopNativeVoice).toHaveBeenCalledOnce());
  await waitFor(() => expect(noticeCard("director-voice")).toBeNull());
});

it("reports a Voice manager that cannot be opened instead of starting voice", async () => {
  const f = voiceFixture();
  vi.mocked(f.api.openVoiceManager!).mockResolvedValueOnce({ status: "failed", error: "Sample manager failure." });
  render(<><DirectorVoiceToast api={f.api} /><Notices api={f.api} /></>);
  await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
  await waitFor(() => expect(noticeCard("native-voice-error")).toHaveTextContent("Sample manager failure."));
  expect(noticeCard("director-voice")).toBeNull();
  expect(f.api.startNativeVoice).not.toHaveBeenCalled();
  expect(f.capture).not.toHaveBeenCalled();
});

// Thread voice opens only on a local Codex thread. Everywhere else the mic
// starts director voice rather than vanishing or going grey: a peer's thread,
// another provider's, and a new-thread launchpad, where the spoken request
// becomes the new thread's task.
it("routes the mic to director voice where thread voice cannot open", async () => {
  expect(threadVoiceTarget({ id: "sample-local", source: "codex" }, undefined)).toEqual({ threadId: "sample-local" });
  expect(threadVoiceTarget(undefined, undefined)).toEqual({});
  expect(threadVoiceTarget({ id: "sample-acp", source: "acp:grok" }, undefined).directorHint).toContain("director voice");
  expect(threadVoiceTarget(
    { id: "sample-peer", source: "codex", federation: { instanceLabel: "Sample Mac mini" } },
    undefined,
  ).directorHint).toContain("Sample Mac mini");
  const launchpad = threadVoiceTarget(undefined, { directoryLabel: "Sample project" });
  expect(launchpad.threadId).toBeUndefined();
  expect(launchpad.directorHint).toContain("Sample project");

  const f = voiceFixture();
  render(<DirectorVoiceComposerToggle api={f.api} hint={launchpad.directorHint!} />);
  const toggle = screen.getByRole("button", { name: "Voice" });
  expect(toggle).toHaveAttribute("data-tooltip", expect.stringContaining("new thread"));
  fireEvent.click(toggle);
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  expect(vi.mocked(f.api.startNativeVoice).mock.calls[0][0]).toMatchObject({ threadId: "sample-voice-manager", mode: "director" });
  expect(toggle).toHaveAttribute("aria-pressed", "true");
});

it("publishes a launchpad's project and settings, never its draft, and only with no thread selected", () => {
  const launchpad = {
    directoryKey: "dir:/sample/project",
    directoryLabel: "Sample project",
    federationTarget: { scope: "remote" as const, instanceId: "sample-peer" },
    backend: "codex" as const,
    model: "sample-model",
    reasoningEffort: "medium",
    executionMode: "default" as const,
    workMode: "worktree" as const,
    prompt: "Sample unsent draft",
  };
  const focus = operatorFocusFor({ view: "thread", launchpad });
  expect(focus.launchpad).toEqual({
    projectKey: "dir:/sample/project",
    projectLabel: "Sample project",
    instanceId: "sample-peer",
    backend: "codex",
    model: "sample-model",
    reasoningEffort: "medium",
    executionMode: "default",
    workMode: "worktree",
  });
  expect(JSON.stringify(focus)).not.toContain("Sample unsent draft");
  expect(operatorFocusFor({
    view: "thread",
    launchpad,
    thread: { id: "sample-thread", source: "codex", title: "Sample thread" },
  }).launchpad).toBeUndefined();
});
