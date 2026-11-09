import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => {
  const page = { entries: [], coverage: { state: "complete" }, nextCursor: "local-next" };
  const local = { getNavigationQueryPage: vi.fn(async () => page), readThread: vi.fn(async () => ({})) };
  const remotePage = vi.fn(async () => ({ ...page, nextCursor: "remote-next" }));
  const submit = vi.fn(async () => ({ state: "accepted" })); const get = vi.fn(async () => null);
  const peers = [{ target: { scope: "remote", instanceId: "peer" }, label: "Lab", capabilities: ["thread_navigation", "thread_detail", "turn_control", "durable_turn_requests_v1"] }];
  return { capability: vi.fn(async () => ({ available: true })), voiceStart: vi.fn(async () => {}), voiceStop: vi.fn(async () => {}), local, remotePage, submit, get, peers, steer: vi.fn(async () => ({ state: "dispatched" })) };
});
vi.mock("../federation/federation-runtime", () => ({ getDesktopFederationRuntime: () => ({
  localFederationInstanceId: () => "gateway", connectedPeerTargets: () => fixture.peers,
  health: async () => ({ peers: [], localLabel: "Studio" }), localBackend: () => fixture.local,
  remoteNavigationQueryPage: fixture.remotePage, submitDurableTurnRequest: fixture.submit, getDurableTurnRequest: fixture.get, submitDurableSteerRequest: fixture.steer, getDurableSteerRequest: fixture.get,
}) }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({ nativeVoiceCapability: fixture.capability }) }));
vi.mock("../native-voice/session-owner", () => ({ getNativeVoiceSessions: () => ({ start: fixture.voiceStart, stopOwner: fixture.voiceStop }) }));
vi.mock("../native-voice/voice-manager-thread", () => ({ openVoiceManagerThread: vi.fn() }));
import { createMobileAdapter } from "../mobile/adapter";
import type { MobileDevice } from "../mobile/device-store";
const device: MobileDevice = { id: "phone", name: "Phone", tokenHash: "hash", scopes: ["read", "send", "voice"], machines: "all" };
beforeEach(() => vi.clearAllMocks());
it("queries every machine by default with independent continuation cursors", async () => {
  const adapter = createMobileAdapter();
  const page = await adapter.request(device, -1, "threads", {}, () => {}) as { cursors: Record<string, string> };
  expect(fixture.local.getNavigationQueryPage).toHaveBeenCalledOnce(); expect(fixture.remotePage).toHaveBeenCalledOnce();
  expect(page.cursors).toEqual({ gateway: "local-next", peer: "remote-next" });
  await adapter.request(device, -1, "threads", { cursors: { peer: "remote-next" } }, () => {});
  expect(fixture.local.getNavigationQueryPage).toHaveBeenCalledOnce(); expect(fixture.remotePage).toHaveBeenCalledTimes(2);
});
it("enforces machine/scope grants before dispatch or receipt lookup", async () => {
  const adapter = createMobileAdapter(); const target = { instanceId: "peer", backend: "codex", threadId: "thread" };
  await expect(adapter.request({ ...device, scopes: ["read"] }, -1, "turn.get", { target, id: "id" }, () => {})).rejects.toThrow("send permission");
  await expect(adapter.request({ ...device, machines: ["gateway"] }, -1, "turn.get", { target, id: "id" }, () => {})).rejects.toThrow("outside device grant");
  expect(fixture.get).not.toHaveBeenCalled();
});
it("derives the stable device principal and preserves original owner routing", async () => {
  const adapter = createMobileAdapter(); const target = { instanceId: "peer", backend: "codex", threadId: "thread" };
  const submission = { clientRequest: { version: 1, id: "uuid", payloadHash: "hash", createdAt: 1 }, request: { backend: "codex", threadId: "thread", input: [{ type: "text", text: "hello" }] } };
  await adapter.request(device, -1, "turn.submit", { target, submission, callerScope: "forged" }, () => {});
  expect(fixture.submit).toHaveBeenCalledWith("mobile:phone", submission, { scope: "remote", instanceId: "peer" });
  await expect(adapter.request(device, -1, "turn.submit", { target, submission: { ...submission, request: { ...submission.request, executionMode: "full-access" } } }, () => {})).rejects.toThrow("Invalid mobile prompt");
  expect(fixture.submit).toHaveBeenCalledOnce();
});
it("denies director voice to a machine-restricted device", async () => {
  await expect(createMobileAdapter().request({ ...device, machines: ["gateway"] }, -1, "voice.start", {}, () => {})).rejects.toThrow("all-machines");
});

it("requires an explicit turn for durable steering and forbids fallback parameters", async () => {
  const adapter = createMobileAdapter();
  const target = { instanceId: "peer", backend: "codex", threadId: "thread" };
  const submission = { clientRequest: { version: 1, id: "uuid", payloadHash: "hash", createdAt: 1 }, request: { backend: "codex", threadId: "thread", input: [{ type: "text", text: "Focus on tests" }], expectedTurnId: "active-turn" } };
  await adapter.request(device, -1, "steer.submit", { target, submission }, () => {});
  expect(fixture.steer).toHaveBeenCalledWith("mobile:phone", submission, { scope: "remote", instanceId: "peer" });
  await expect(adapter.request(device, -1, "steer.submit", { target, submission: { ...submission, request: { ...submission.request, expectedTurnId: undefined } } }, () => {})).rejects.toThrow("Invalid request field");
  await expect(adapter.request(device, -1, "steer.submit", { target, submission: { ...submission, request: { ...submission.request, fallback: true } } }, () => {})).rejects.toThrow("Invalid mobile prompt");
  expect(fixture.submit).not.toHaveBeenCalled();
});

it("does not start billed voice after disconnect during capability lookup", async () => {
  let finish!: (result: { available: boolean }) => void;
  fixture.capability.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const adapter = createMobileAdapter();
  const pending = adapter.request(device, -1, "voice.start", { sessionId: "voice", sdp: "v=0" }, () => {});
  await adapter.disconnected(-1);
  finish({ available: true });
  await expect(pending).rejects.toThrow("Live cancelled");
  expect(fixture.voiceStart).not.toHaveBeenCalled();
});

it("retains voice ownership and retries cancellation when the phone is gone", async () => {
  vi.useFakeTimers();
  try {
    fixture.voiceStop.mockRejectedValueOnce(new Error("stop acknowledgment lost"));
    const adapter = createMobileAdapter();
    await expect(adapter.disconnected(-1)).rejects.toThrow("acknowledgment lost");
    await expect(adapter.request(device, -1, "voice.start", { sessionId: "replacement", sdp: "v=0" }, () => {})).rejects.toThrow("already starting or open");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.voiceStop).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
