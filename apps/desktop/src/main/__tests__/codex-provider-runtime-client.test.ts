import { describe, expect, it, vi } from "vitest";
import type { AppServerNotification, AppServerPendingRequestNotification, CodexModelProviderSettings } from "@pwragent/shared";
import type { CodexAppServerClient } from "../codex-app-server/client";
import { createProviderRuntimeClient } from "../codex-app-server/provider-runtime-client";
import type { NativeVoiceNotification } from "../codex-app-server/native-voice-protocol";

const bonsai: CodexModelProviderSettings = {
  id: "bonsai", name: "Bonsai", baseUrl: "http://127.0.0.1:18080/v1", models: ["Bonsai.gguf"], compatibility: "bonsai",
};

function fixture() {
  const notifications = new Set<(event: AppServerNotification) => void>();
  const requests = new Set<(event: AppServerPendingRequestNotification) => Promise<unknown>>();
  const exits = new Set<() => void>();
  const realtimeEvents = new Set<(event: NativeVoiceNotification) => void>();
  const realtimeDisconnects = new Set<() => void>();
  const providers = new Map<string, string>();
  const raw = {
    startThread: vi.fn(async () => ({ threadId: "new-thread" })),
    forkThread: vi.fn(async () => ({ threadId: "forked-thread" })),
    startTurn: vi.fn(async () => ({ turnId: "turn" })),
    interruptTurn: vi.fn(async () => undefined),
    steerTurn: vi.fn(async () => ({ threadId: "new-thread", turnId: "turn" })),
    terminateBackgroundTerminal: vi.fn(async () => true),
    startRealtime: vi.fn(async () => undefined),
    readThreadSummary: vi.fn(async () => ({ id: "persisted" })),
    readThread: vi.fn(async () => ({ entries: [] })),
    readMcpApprovalUserMessages: vi.fn(async () => []),
    readThreadToolInvocation: vi.fn(async () => []),
    readTurnRoot: vi.fn(async () => "root-turn"),
    listThreads: vi.fn(async () => []),
    listMcpServers: vi.fn(async () => []),
    recoverInvalidPersistedResponseMessageIds: vi.fn(async () => ({})),
    modelProviderForThread: (id: string) => providers.get(id),
    close: vi.fn(async () => undefined),
    resetAppServerRestarts: vi.fn(),
    getAppServerRestartStatus: vi.fn(() => ({ stopped: false })),
    onNotification: (listener: (event: AppServerNotification) => void) => {
      notifications.add(listener); return () => notifications.delete(listener);
    },
    onRequest: (listener: (event: AppServerPendingRequestNotification) => Promise<unknown>) => {
      requests.add(listener); return () => requests.delete(listener);
    },
    onAppServerUnexpectedExit: (listener: () => void) => {
      exits.add(listener); return () => exits.delete(listener);
    },
    onRealtimeEvent: (listener: (event: NativeVoiceNotification) => void) => {
      realtimeEvents.add(listener); return () => realtimeEvents.delete(listener);
    },
    onRealtimeDisconnect: (listener: () => void) => {
      realtimeDisconnects.add(listener); return () => realtimeDisconnects.delete(listener);
    },
  };
  return { raw, client: raw as unknown as CodexAppServerClient, providers, notifications, requests, exits, realtimeEvents, realtimeDisconnects };
}

describe("provider-specific Codex runtimes", () => {
  function setup() {
    const primary = fixture();
    const local = fixture();
    const providers = [bonsai];
    const create = vi.fn(() => local.client);
    const client = createProviderRuntimeClient(primary.client, { resolveProviders: () => providers, create });
    return { primary, local, create, client, providers };
  }

  it("routes Bonsai starts and subsequent operations to one lazy client while OpenAI stays on the primary", async () => {
    const { primary, local, create, client } = setup();
    expect(create).not.toHaveBeenCalled();
    await client.startThread({ model: "gpt-5.5" });
    await client.startThread({ model: "@bonsai/Bonsai.gguf" });
    await client.startTurn({ threadId: "new-thread", input: [{ type: "text", text: "hello" }] });
    await client.interruptTurn({ threadId: "new-thread", turnId: "turn" });
    expect(primary.raw.startThread).toHaveBeenCalledWith({ model: "gpt-5.5" });
    expect(local.raw.startThread).toHaveBeenCalledWith({ model: "@bonsai/Bonsai.gguf" });
    expect(local.raw.startTurn).toHaveBeenCalledOnce();
    expect(local.raw.interruptTurn).toHaveBeenCalledOnce();
    expect(primary.raw.startTurn).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledExactlyOnceWith(bonsai);
  });

  it("resolves persisted thread ownership through App Server before a turn, including plain model IDs", async () => {
    const { primary, local, client } = setup();
    primary.providers.set("persisted", "bonsai");
    await client.startTurn({ threadId: "persisted", model: "Bonsai.gguf", input: [{ type: "text", text: "hello" }] });
    expect(primary.raw.readThreadSummary).toHaveBeenCalledWith("persisted");
    expect(local.raw.startTurn).toHaveBeenCalledOnce();
    await expect(client.startTurn({ threadId: "persisted", model: "@another/model", input: [] })).rejects.toThrow("Hand it off");
  });

  it("keeps live operations on their owner after provider removal until the pool closes", async () => {
    const { primary, local, client, providers } = setup();
    await client.startThread({ model: "@bonsai/Bonsai.gguf" });
    providers.splice(0);
    await client.interruptTurn({ threadId: "new-thread", turnId: "turn" });
    await client.steerTurn({ threadId: "new-thread", expectedTurnId: "turn", input: [] });
    await client.terminateBackgroundTerminal("new-thread", "process");
    expect(local.raw.interruptTurn).toHaveBeenCalledOnce();
    expect(local.raw.steerTurn).toHaveBeenCalledOnce();
    expect(local.raw.terminateBackgroundTerminal).toHaveBeenCalledWith("new-thread", "process");
    expect(primary.raw.interruptTurn).not.toHaveBeenCalled();
    expect(primary.raw.steerTurn).not.toHaveBeenCalled();
    expect(primary.raw.terminateBackgroundTerminal).not.toHaveBeenCalled();
    await client.close();
    expect(local.raw.close).toHaveBeenCalledOnce();
    await client.startThread({ model: "gpt-5.5" });
    expect(primary.raw.startThread).toHaveBeenCalledOnce();
  });

  it("routes scoped realtime events and disconnects to the voice session's runtime", async () => {
    const { primary, local, client } = setup();
    primary.providers.set("persisted", "bonsai");
    const localEvent = vi.fn();
    const localDisconnect = vi.fn();
    const primaryDisconnect = vi.fn();
    const stopEvent = client.onRealtimeEvent(localEvent, "persisted");
    const stopDisconnect = client.onRealtimeDisconnect(localDisconnect, "persisted");
    const stopPrimary = client.onRealtimeDisconnect(primaryDisconnect, "openai-thread");
    await client.startRealtime({ threadId: "persisted", outputModality: "audio", transport: { type: "webrtc", sdp: "offer" } });
    expect(local.raw.startRealtime).toHaveBeenCalledOnce();
    const event: NativeVoiceNotification = { method: "thread/realtime/sdp", params: { threadId: "persisted", sdp: "answer" } };
    for (const listener of local.realtimeEvents) listener(event);
    expect(localEvent).toHaveBeenCalledWith(event);
    for (const listener of local.realtimeDisconnects) listener();
    expect(localDisconnect).toHaveBeenCalledOnce();
    expect(primaryDisconnect).not.toHaveBeenCalled();
    for (const listener of primary.realtimeEvents) listener(event);
    expect(localEvent).toHaveBeenCalledOnce();
    for (const listener of primary.realtimeDisconnects) listener();
    expect(primaryDisconnect).toHaveBeenCalledOnce();
    expect(localDisconnect).toHaveBeenCalledOnce();
    stopEvent(); stopDisconnect(); stopPrimary();
    expect(local.realtimeEvents.size + primary.realtimeEvents.size).toBe(0);
    expect(local.realtimeDisconnects.size + primary.realtimeDisconnects.size).toBe(0);
    const lateListener = vi.fn();
    const stopLate = client.onRealtimeEvent(lateListener, "persisted");
    for (const listener of local.realtimeEvents) listener(event);
    expect(lateListener).toHaveBeenCalledWith(event);
    stopLate();
  });

  it("reads persisted history without needing a local inference server and uses the live owner once started", async () => {
    const { primary, local, create, client } = setup();
    primary.providers.set("persisted", "bonsai");
    await client.readThread({ threadId: "persisted" });
    expect(primary.raw.readThread).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    await client.startTurn({ threadId: "persisted", input: [] });
    await client.readThread({ threadId: "persisted" });
    expect(local.raw.readThread).toHaveBeenCalledOnce();
  });

  it("reads MCP approval evidence from persisted history or its live provider owner", async () => {
    const { primary, local, create, client } = setup();
    primary.providers.set("persisted", "bonsai");
    const params = { threadId: "persisted", turnId: "turn", signal: new AbortController().signal };
    await client.readMcpApprovalUserMessages(params);
    expect(primary.raw.readMcpApprovalUserMessages).toHaveBeenCalledExactlyOnceWith(params);
    expect(create).not.toHaveBeenCalled();
    await client.startTurn({ threadId: "persisted", input: [] });
    await client.readMcpApprovalUserMessages(params);
    expect(local.raw.readMcpApprovalUserMessages).toHaveBeenCalledExactlyOnceWith(params);
    await client.readMcpApprovalUserMessages({ ...params, threadId: "openai-thread" });
    expect(primary.raw.readMcpApprovalUserMessages).toHaveBeenLastCalledWith({ ...params, threadId: "openai-thread" });
    expect(local.raw.readMcpApprovalUserMessages).toHaveBeenCalledOnce();
  });

  it("routes tool details and turn ancestry through history fallback, then their live owner", async () => {
    const { primary, local, create, client } = setup();
    primary.providers.set("persisted", "bonsai");
    const turn = { threadId: "persisted", turnId: "turn" };
    const invocation = { ...turn, itemId: "command" };
    await client.readThreadToolInvocation(invocation);
    await client.readTurnRoot(turn);
    expect(primary.raw.readThreadToolInvocation).toHaveBeenCalledWith(invocation);
    expect(primary.raw.readTurnRoot).toHaveBeenCalledWith(turn);
    expect(create).not.toHaveBeenCalled();
    await client.startTurn({ threadId: "persisted", input: [] });
    await client.readThreadToolInvocation(invocation);
    await client.readTurnRoot(turn);
    expect(local.raw.readThreadToolInvocation).toHaveBeenCalledExactlyOnceWith(invocation);
    expect(local.raw.readTurnRoot).toHaveBeenCalledExactlyOnceWith(turn);
    await client.readThreadToolInvocation({ ...invocation, threadId: "openai-thread" });
    await client.readTurnRoot({ ...turn, threadId: "openai-thread" });
    expect(primary.raw.readThreadToolInvocation).toHaveBeenLastCalledWith({ ...invocation, threadId: "openai-thread" });
    expect(primary.raw.readTurnRoot).toHaveBeenLastCalledWith({ ...turn, threadId: "openai-thread" });
    expect(local.raw.readThreadToolInvocation).toHaveBeenCalledOnce();
    expect(local.raw.readTurnRoot).toHaveBeenCalledOnce();
  });

  it("keeps a stopped Bonsai process out of the global OpenAI restart status", async () => {
    const { primary, local, client } = setup();
    await client.startThread({ model: "@bonsai/Bonsai.gguf" });
    local.raw.getAppServerRestartStatus.mockReturnValue({ stopped: true });
    expect(client.getAppServerRestartStatus()).toEqual({ stopped: false });
    expect(primary.raw.getAppServerRestartStatus).toHaveBeenCalled();
    expect(local.raw.getAppServerRestartStatus).not.toHaveBeenCalled();
  });

  it("propagates events and keeps request IDs and unexpected exits scoped to their runtime", async () => {
    const { primary, local, client } = setup();
    primary.raw.startThread.mockResolvedValueOnce({ threadId: "openai-thread" });
    const notifications = vi.fn();
    const requests = vi.fn(async () => ({ approved: true }));
    const exits = vi.fn();
    client.onNotification(notifications);
    client.onRequest(requests);
    client.onAppServerUnexpectedExit(exits);
    await client.startThread({ model: "gpt-5.5" });
    await client.startThread({ model: "@bonsai/Bonsai.gguf" });
    const event = { method: "turn/completed", params: { threadId: "new-thread", turn: { id: "turn", status: "completed" } } } as AppServerNotification;
    for (const listener of local.notifications) listener(event);
    expect(notifications).toHaveBeenCalledWith(event);
    for (const listener of local.requests) await listener({ method: "item/tool/call", params: { threadId: "new-thread", requestId: "1" } });
    expect(requests).toHaveBeenCalledWith(expect.objectContaining({ params: { threadId: "new-thread", requestId: "bonsai:1" } }));
    for (const listener of local.exits) listener();
    expect(exits).toHaveBeenLastCalledWith(new Set(["new-thread"]));
    for (const listener of primary.exits) listener();
    expect(exits).toHaveBeenLastCalledWith(new Set(["openai-thread"]));
  });

  it("runs recovery on the owning client and closes every runtime even when one close fails", async () => {
    const { primary, local, create, client } = setup();
    await client.startThread({ model: "@bonsai/Bonsai.gguf" });
    await client.recoverInvalidPersistedResponseMessageIds({ threadId: "new-thread", failureMessage: "fixture" });
    expect(local.raw.recoverInvalidPersistedResponseMessageIds).toHaveBeenCalledOnce();
    expect(primary.raw.recoverInvalidPersistedResponseMessageIds).not.toHaveBeenCalled();
    primary.raw.close.mockRejectedValueOnce(new Error("primary close failed"));
    await expect(client.close()).rejects.toThrow("primary close failed");
    expect(local.raw.close).toHaveBeenCalledOnce();
    await client.startThread({ model: "@bonsai/Bonsai.gguf" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not revive a runtime when close races a persisted-ownership read", async () => {
    const { primary, create, client } = setup();
    let finish!: () => void;
    primary.providers.set("persisted", "bonsai");
    primary.raw.readThreadSummary.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ id: "persisted" });
    }));
    const turn = client.startTurn({ threadId: "persisted", input: [] });
    const rejected = expect(turn).rejects.toThrow("closed during routing");
    await client.close();
    finish();
    await rejected;
    expect(create).not.toHaveBeenCalled();
  });
});
