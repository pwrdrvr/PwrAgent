import { describe, expect, it, vi } from "vitest";
import type { AppServerNotification, AppServerPendingRequestNotification, CodexModelProviderSettings } from "@pwragent/shared";
import type { CodexAppServerClient } from "../codex-app-server/client";
import { createProviderRuntimeClient } from "../codex-app-server/provider-runtime-client";

const bonsai: CodexModelProviderSettings = {
  id: "bonsai", name: "Bonsai", baseUrl: "http://127.0.0.1:18080/v1", models: ["Bonsai.gguf"], compatibility: "bonsai",
};

function fixture() {
  const notifications = new Set<(event: AppServerNotification) => void>();
  const requests = new Set<(event: AppServerPendingRequestNotification) => Promise<unknown>>();
  const exits = new Set<() => void>();
  const providers = new Map<string, string>();
  const raw = {
    startThread: vi.fn(async () => ({ threadId: "new-thread" })),
    forkThread: vi.fn(async () => ({ threadId: "forked-thread" })),
    startTurn: vi.fn(async () => ({ turnId: "turn" })),
    interruptTurn: vi.fn(async () => undefined),
    readThreadSummary: vi.fn(async () => ({ id: "persisted" })),
    readThread: vi.fn(async () => ({ entries: [] })),
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
  };
  return { raw, client: raw as unknown as CodexAppServerClient, providers, notifications, requests, exits };
}

describe("provider-specific Codex runtimes", () => {
  function setup() {
    const primary = fixture();
    const local = fixture();
    const create = vi.fn(() => local.client);
    const client = createProviderRuntimeClient(primary.client, { resolveProviders: () => [bonsai], create });
    return { primary, local, create, client };
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
