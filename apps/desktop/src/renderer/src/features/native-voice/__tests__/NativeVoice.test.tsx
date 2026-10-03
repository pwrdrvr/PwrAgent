import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCallback, useState, type FormEvent } from "react";
import type { NativeVoiceApi, NativeVoiceCapability } from "../../../../../shared/native-voice";
import { NativeVoiceBar, NativeVoiceToggle, threadVoiceTarget, useNativeVoiceNotices } from "../NativeVoice";
import { DirectorVoiceButton, DirectorVoiceComposerToggle, DirectorVoicePanel, operatorFocusFor, toggleDirectorVoice } from "../DirectorVoice";
import type { AgentEvent } from "@pwragent/shared";
import { AppNoticeToast, type AppNoticeToastNotice } from "../../notifications/AppNoticeToast";
import { getWindowNativeVoiceController, MUTED_IDLE_END_MS, MUTED_STALL_END_MS, type NativeVoiceController } from "../native-voice-controller";
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
  const agentListeners = new Set<(event: AgentEvent) => void>();
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
    onAgentEvent: (listener) => { agentListeners.add(listener); return () => { agentListeners.delete(listener); }; },
  };
  const owner = getWindowNativeVoiceController(api);
  owners.add(owner);
  const emit = (event: NativeVoiceEvent) => { act(() => { for (const listener of listeners) listener(event); }); };
  const agent = (notification: { method: string; params: Record<string, unknown> }) => {
    act(() => { for (const listener of agentListeners) listener({ backend: "codex", notification } as unknown as AgentEvent); });
  };
  return { api, owner, capture, peer, track, listeners, emit, agent };
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
const directorPanel = () => screen.queryByRole("region", { name: "Director voice" });

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

  // The session clock runs from the moment voice went live.
  expect(screen.getByRole("timer")).toHaveTextContent(/^\d+s$/);
  fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
  expect(f.track.enabled).toBe(false);
  expect(screen.getByRole("status", { name: "Voice status" })).toHaveTextContent("Muted, ends after the reply");
  fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
  expect(f.track.enabled).toBe(true);
});

// "Ask, mute, listen": muting must not cut the reply off, and must not leave
// a session open (and billing) for hours after the reply.
it("ends a muted session only after its reply and its turn are done", async () => {
  const f = voiceFixture();
  render(<><Composer api={f.api} threadId="sample-thread" /><Notices api={f.api} /></>);
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  const sessionId = vi.mocked(f.api.startNativeVoice).mock.calls[0][0].sessionId;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.emit({ sessionId, type: "transcript", role: "user", text: "What is running?", done: true });
    f.agent({ method: "turn/started", params: { threadId: "sample-thread", turn: { id: "sample-turn" } } });
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));

    // A running turn and a reply mid-sentence both hold the session open.
    act(() => { vi.advanceTimersByTime(MUTED_IDLE_END_MS * 4); });
    f.emit({ sessionId, type: "transcript", role: "assistant", text: "Two threads", done: false });
    f.agent({ method: "turn/completed", params: { threadId: "sample-thread", turn: { id: "sample-turn" } } });
    act(() => { vi.advanceTimersByTime(MUTED_IDLE_END_MS * 4); });
    expect(f.api.stopNativeVoice).not.toHaveBeenCalled();

    // Another thread's turn is not this session's.
    f.emit({ sessionId, type: "transcript", role: "assistant", text: "Two threads are running.", done: true });
    f.agent({ method: "turn/started", params: { threadId: "sample-other-thread", turn: { id: "sample-other" } } });
    act(() => { vi.advanceTimersByTime(MUTED_IDLE_END_MS - 1); });
    expect(f.api.stopNativeVoice).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(f.api.stopNativeVoice).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() => expect(f.owner.getView().status).toBe("idle"));
  expect(noticeCard("native-voice-ended")).toHaveTextContent("Voice ended after its reply because the microphone was muted.");
});

// A turn blocked on a question, or a reply whose last line never reports
// done, must not hold a muted session open for hours.
it("ends a muted session that stays busy past the stall ceiling", async () => {
  const f = voiceFixture();
  render(<Composer api={f.api} threadId="sample-thread" />);
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.agent({ method: "turn/started", params: { threadId: "sample-thread", turn: { id: "sample-turn" } } });
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    await act(async () => { vi.advanceTimersByTime(MUTED_STALL_END_MS - 1); });
    expect(f.api.stopNativeVoice).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(f.api.stopNativeVoice).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

// Turns that began before voice send no turn/started; the composer says so.
it("treats a thread's already-running turn as busy when voice starts", async () => {
  const f = voiceFixture();
  render(<><NativeVoiceBar api={f.api} threadId="sample-thread" /><NativeVoiceToggle api={f.api} threadId="sample-thread" turnRunning /></>);
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    await act(async () => { vi.advanceTimersByTime(MUTED_IDLE_END_MS * 4); });
    expect(f.api.stopNativeVoice).not.toHaveBeenCalled();
    f.agent({ method: "turn/completed", params: { threadId: "sample-thread", turn: { id: "sample-turn" } } });
    await act(async () => { vi.advanceTimersByTime(MUTED_IDLE_END_MS); });
    expect(f.api.stopNativeVoice).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps an unmuted or re-unmuted session open while it is quiet", async () => {
  const f = voiceFixture();
  render(<Composer api={f.api} threadId="sample-thread" />);
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    act(() => { vi.advanceTimersByTime(MUTED_IDLE_END_MS * 2); });
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    act(() => { vi.advanceTimersByTime(MUTED_IDLE_END_MS - 1); });
    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
    act(() => { vi.advanceTimersByTime(MUTED_IDLE_END_MS * 2); });
    expect(f.api.stopNativeVoice).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
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
  render(<DirectorVoicePanel api={f.api} focus={{ id: "sample-first-thread", source: "codex", title: "Sample first thread" }} />);
  await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  expect(vi.mocked(f.api.startNativeVoice).mock.calls[0][0]).toMatchObject({ threadId: "sample-voice-manager", mode: "director" });
  expect(directorPanel()).toHaveTextContent("Looking at: Sample first thread");

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

  // The panel's close button ends the session, and says so.
  fireEvent.click(screen.getByRole("button", { name: "End director voice" }));
  await waitFor(() => expect(f.api.stopNativeVoice).toHaveBeenCalledOnce());
  await waitFor(() => expect(directorPanel()).toBeNull());
});

// Ask, mute, listen: the session ends after the reply, and the operator
// still has the transcript to read.
it("keeps the director transcript after a muted session ends, until closed or started again", async () => {
  const f = voiceFixture();
  render(<><DirectorVoicePanel api={f.api} /><Notices api={f.api} /></>);
  await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  expect(directorPanel()).toHaveTextContent("Looking at: no thread");
  const sessionId = vi.mocked(f.api.startNativeVoice).mock.calls[0][0].sessionId;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  try {
    f.emit({ sessionId, type: "transcript", role: "user", text: "Which PRs are green?", done: true });
    f.emit({ sessionId, type: "transcript", role: "assistant", text: "Two sample PRs are green.", done: true });
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    // The state has its own row, off the header with the controls.
    const state = within(directorPanel()!).getByRole("status", { name: "Voice status" });
    expect(state).toHaveTextContent("Muted·ends 30s after the reply");
    expect(state.closest("header")).toBeNull();
    act(() => { vi.advanceTimersByTime(MUTED_IDLE_END_MS); });
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() => expect(f.owner.getView().status).toBe("idle"));
  expect(f.api.stopNativeVoice).toHaveBeenCalledOnce();

  const panel = directorPanel();
  expect(panel).toHaveTextContent("Ended after the reply");
  expect(screen.getByRole("log", { name: "Voice transcript" })).toHaveTextContent("Voice: Two sample PRs are green.");
  expect(screen.getByRole("timer")).toHaveAccessibleName(/^Voice was open for /);
  expect(screen.queryByRole("textbox", { name: "Message voice" })).toBeNull();
  // What "this" means only matters while the voice can hear it.
  expect(panel).not.toHaveTextContent("Looking at:");
  // The panel says how it ended; no second notice repeats it.
  expect(noticeCard("native-voice-ended")).toBeNull();

  // Starting again replaces the old transcript with the new session's.
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start director voice" })); });
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  expect(f.api.startNativeVoice).toHaveBeenCalledTimes(2);
  expect(directorPanel()).toHaveTextContent("Microphone live");
  expect(screen.queryByRole("log", { name: "Voice transcript" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "End director voice" }));
  await waitFor(() => expect(directorPanel()).toBeNull());
});

it("keeps an ended director panel until the operator closes it", async () => {
  const f = voiceFixture();
  render(<DirectorVoicePanel api={f.api} launchpad={{ directoryLabel: "Sample project" }} />);
  await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  // A launchpad is where the voice would start a thread, not a thread it is starting.
  expect(directorPanel()).toHaveTextContent("Looking at: new thread in Sample project");
  const sessionId = vi.mocked(f.api.startNativeVoice).mock.calls[0][0].sessionId;
  f.emit({ sessionId, type: "transcript", role: "assistant", text: "Sample answer.", done: true });
  // The service closes the session; nothing the operator did.
  f.emit({ sessionId, type: "closed" });
  await waitFor(() => expect(f.owner.getView().status).not.toBe("listening"));
  await waitFor(() => expect(directorPanel()).toHaveTextContent("Voice ended"));
  expect(directorPanel()).toHaveTextContent("Voice: Sample answer.");
  fireEvent.click(screen.getByRole("button", { name: "Close director voice" }));
  expect(directorPanel()).toBeNull();
});

it("reports a Voice manager that cannot be opened instead of starting voice", async () => {
  const f = voiceFixture();
  vi.mocked(f.api.openVoiceManager!).mockResolvedValueOnce({ status: "failed", error: "Sample manager failure." });
  render(<><DirectorVoicePanel api={f.api} /><Notices api={f.api} /></>);
  await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
  await waitFor(() => expect(noticeCard("native-voice-error")).toHaveTextContent("Sample manager failure."));
  expect(directorPanel()).toBeNull();
  expect(f.api.startNativeVoice).not.toHaveBeenCalled();
  expect(f.capture).not.toHaveBeenCalled();
});

function agentEvents() {
  const listeners = new Set<(event: AgentEvent) => void>();
  const submitServerRequest = vi.fn(async () => ({ backend: "codex" as const, threadId: "sample-voice-manager", requestId: "sample-request" }));
  return {
    submitServerRequest,
    desktopApi: {
      onAgentEvent: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      submitServerRequest,
    } as never,
    emit: (event: AgentEvent) => { act(() => { for (const listener of listeners) listener(event); }); },
  };
}

const trustQuestion = (threadId: string) => ({
  backend: "codex",
  notification: {
    method: "item/tool/requestUserInput",
    params: {
      threadId, turnId: "sample-turn", requestId: "sample-request",
      questions: [{
        id: "sample-question", header: "Trust directory", question: "Trust /sample/project?",
        isOther: false, isSecret: false,
        options: [{ label: "Trust directory", description: "Trust it." }, { label: "Cancel handoff", description: "Do not." }],
      }],
    },
  },
}) as unknown as AgentEvent;

// Nobody reads the Voice manager thread. A question a tool asks there (here
// handoff_task's directory trust) used to wait, unseen, until voice ended.
it("answers the Voice manager's question from the director panel", async () => {
  const f = voiceFixture();
  const events = agentEvents();
  render(<DirectorVoicePanel api={f.api} desktopApi={events.desktopApi} />);
  await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));

  // Another thread's question is not the director's.
  events.emit(trustQuestion("sample-other-thread"));
  expect(screen.queryByRole("group", { name: "Director voice is waiting on you" })).toBeNull();

  events.emit(trustQuestion("sample-voice-manager"));
  const request = screen.getByRole("group", { name: "Director voice is waiting on you" });
  expect(request).toHaveTextContent("Trust /sample/project?");
  fireEvent.click(screen.getByRole("button", { name: /Trust directory/ }));
  await waitFor(() => expect(events.submitServerRequest).toHaveBeenCalledWith({
    backend: "codex", threadId: "sample-voice-manager", turnId: "sample-turn", requestId: "sample-request",
    response: { answers: { "sample-question": { answers: ["Trust directory"] } } },
  }));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Director voice is waiting on you" })).toBeNull());
});

// A question can outlive the session that raised it: the turn is still
// blocked when director voice starts again.
it("shows a Voice manager question that was already pending when voice opened", async () => {
  const f = voiceFixture();
  const events = agentEvents();
  const pending = trustQuestion("sample-voice-manager").notification;
  const readThread = vi.fn(async () => ({ pendingRequest: pending }));
  render(<DirectorVoicePanel api={f.api} desktopApi={{ ...(events.desktopApi as object), readThread } as never} />);
  await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
  await waitFor(() => expect(screen.getByRole("group", { name: "Director voice is waiting on you" }))
    .toHaveTextContent("Trust /sample/project?"));
  expect(readThread).toHaveBeenCalledWith({ backend: "codex", threadId: "sample-voice-manager", includeTurns: false, limit: 1 });
});

it("drops a Voice manager question that was answered elsewhere", async () => {
  const f = voiceFixture();
  const events = agentEvents();
  render(<DirectorVoicePanel api={f.api} desktopApi={events.desktopApi} />);
  await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  events.emit(trustQuestion("sample-voice-manager"));
  expect(screen.getByRole("group", { name: "Director voice is waiting on you" })).toBeInTheDocument();
  events.emit({
    backend: "codex",
    notification: { method: "serverRequest/resolved", params: { threadId: "sample-voice-manager", requestId: "sample-request" } },
  } as unknown as AgentEvent);
  expect(screen.queryByRole("group", { name: "Director voice is waiting on you" })).toBeNull();
});

it("offers the Voice manager thread for an approval the panel cannot show", async () => {
  const f = voiceFixture();
  const events = agentEvents();
  const onOpenThread = vi.fn();
  render(<DirectorVoicePanel api={f.api} desktopApi={events.desktopApi} onOpenThread={onOpenThread} />);
  await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  events.emit({
    backend: "codex",
    notification: { method: "item/commandExecution/requestApproval", params: { threadId: "sample-voice-manager", requestId: "sample-approval" } },
  } as unknown as AgentEvent);
  fireEvent.click(screen.getByRole("button", { name: "Open Voice manager" }));
  expect(onOpenThread).toHaveBeenCalledWith("sample-voice-manager");
});

it("resizes the director panel from its grip and remembers the size", async () => {
  window.localStorage.removeItem("pwragent:director-voice-panel");
  const f = voiceFixture();
  render(<DirectorVoicePanel api={f.api} />);
  await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
  await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
  const panel = directorPanel()!;
  // Top right, clear of the notice stack in the bottom-left corner.
  expect(Number.parseFloat(panel.style.left)).toBe(window.innerWidth - 400 - 16);
  expect(Number.parseFloat(panel.style.top)).toBe(44);
  const before = Number.parseFloat(panel.style.width);
  fireEvent.keyDown(screen.getByRole("button", { name: "Resize director voice" }), { key: "ArrowLeft" });
  expect(Number.parseFloat(panel.style.width)).toBe(before - 16);
  expect(JSON.parse(window.localStorage.getItem("pwragent:director-voice-panel")!)).toMatchObject({ width: before - 16 });
});

// The panel floats at its own layer and its tooltips portal to the body, so
// a tooltip left on the default viewport-tooltip layer paints under the
// panel it describes. Resolved through the real stylesheets, not a copy.
it("draws the director panel's tooltips above the panel", async () => {
  const styles = document.createElement("style");
  styles.textContent = ["../../../styles/app.css", "../native-voice.css"]
    .map((file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"))
    .join("\n");
  document.head.append(styles);
  try {
    const f = voiceFixture();
    // The masthead mic's hover card can drop over the panel too.
    render(<><DirectorVoiceButton api={f.api} /><DirectorVoicePanel api={f.api} /></>);
    await act(async () => { await toggleDirectorVoice(f.api, f.owner); });
    await waitFor(() => expect(f.owner.getView().status).toBe("listening"));
    const panelLayer = Number(getComputedStyle(directorPanel()!).zIndex);
    expect(panelLayer).toBeGreaterThan(0);
    for (const name of ["Director voice", "Mute microphone", "Copy transcript", "End director voice", "Resize director voice"]) {
      fireEvent.mouseEnter(screen.getByRole("button", { name }));
      const tooltip = await screen.findByRole("tooltip");
      expect(Number(getComputedStyle(tooltip).zIndex), name).toBeGreaterThan(panelLayer);
      fireEvent.mouseLeave(screen.getByRole("button", { name }));
      await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    }
  } finally {
    styles.remove();
  }
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
