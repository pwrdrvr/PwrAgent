import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { ensureWindowThreadMounted } from "../ensure-window-thread-mounted";

const target = { scope: "remote" as const, instanceId: "peer" };
const request = { backend: "codex" as const, threadId: "thread", federationTarget: target };
const ref = { backend: request.backend, threadId: request.threadId, target };

describe("ensureWindowThreadMounted", () => {
  it("checks persisted membership when a peer thread is absent from loaded pages", async () => {
    const hasRemoteThreadPin = vi.fn(async () => true);
    const addRemoteThreadPin = vi.fn();
    await ensureWindowThreadMounted({ hasRemoteThreadPin, addRemoteThreadPin }, request, [], false);
    expect(hasRemoteThreadPin).toHaveBeenCalledWith({ ref });
    expect(addRemoteThreadPin).not.toHaveBeenCalled();
  });

  it("adds a genuinely unmounted peer after the persisted lookup", async () => {
    const hasRemoteThreadPin = vi.fn(async () => false);
    const addRemoteThreadPin = vi.fn();
    await ensureWindowThreadMounted({ hasRemoteThreadPin, addRemoteThreadPin }, request, [], false);
    expect(hasRemoteThreadPin).toHaveBeenCalledWith({ ref });
    expect(addRemoteThreadPin).toHaveBeenCalledWith({ ref });
  });

  it("matches the complete owner and backend identity in its loaded-row fast path", async () => {
    const loaded: NavigationThreadSummary = {
      id: request.threadId, source: request.backend, title: "Fixture", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false }, federation: { ref, instanceLabel: "Peer" },
    };
    const hasRemoteThreadPin = vi.fn(async () => true);
    await ensureWindowThreadMounted({ hasRemoteThreadPin }, request, [loaded], false);
    expect(hasRemoteThreadPin).not.toHaveBeenCalled();
    await ensureWindowThreadMounted({ hasRemoteThreadPin }, { ...request, backend: "acp:kimi" }, [loaded], false);
    expect(hasRemoteThreadPin).toHaveBeenLastCalledWith({ ref: { ...ref, backend: "acp:kimi" } });
    await ensureWindowThreadMounted({ hasRemoteThreadPin }, {
      ...request, federationTarget: { ...target, instanceId: "other-peer" },
    }, [loaded], false);
    expect(hasRemoteThreadPin).toHaveBeenLastCalledWith({ ref: { ...ref, target: { ...target, instanceId: "other-peer" } } });
  });

  it("does not perform viewer membership reads for local threads or remote viewers", async () => {
    const hasRemoteThreadPin = vi.fn();
    const addRemoteThreadPin = vi.fn();
    await ensureWindowThreadMounted({ hasRemoteThreadPin, addRemoteThreadPin }, { backend: "codex", threadId: "local" }, [], false);
    await ensureWindowThreadMounted({ hasRemoteThreadPin, addRemoteThreadPin }, request, [], true);
    expect(hasRemoteThreadPin).not.toHaveBeenCalled();
    expect(addRemoteThreadPin).not.toHaveBeenCalled();
  });

  it("does not infer missing membership when the lookup is unavailable or fails", async () => {
    const addRemoteThreadPin = vi.fn();
    await expect(ensureWindowThreadMounted({ addRemoteThreadPin }, request, [], false)).rejects.toThrow("cannot check");
    const hasRemoteThreadPin = vi.fn(async () => { throw new Error("lookup failed"); });
    await expect(ensureWindowThreadMounted({ hasRemoteThreadPin, addRemoteThreadPin }, request, [], false)).rejects.toThrow("lookup failed");
    expect(addRemoteThreadPin).not.toHaveBeenCalled();
  });
});
