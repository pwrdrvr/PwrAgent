import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import type { MessagingBackendEventContext } from "../messaging/core/messaging-backend-event-context";
import { MessagingBackendEventRouter } from "../messaging/core/messaging-backend-event-router";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { messagingModules } from "./fixtures/messaging-controller-modules";
import { messagingCanonicalQueueHarness } from "./fixtures/messaging-canonical-queue-harness";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const real = await messagingCanonicalQueueHarness();
  return { store: real.store, ...messagingModules(real.controller), close: () => real.close() };
}

const binding: MessagingBindingRecord = {
  id: "fixture-binding", backend: "codex", threadId: "fixture-thread", createdAt: 1_000, updatedAt: 1_000,
  authorizedActorIds: [], channel: { channel: "telegram", conversation: { id: "fixture-conversation", kind: "dm" } },
};

describe("MessagingBackendEventRouter", () => {
  it("does not read any context capability while constructing", () => {
    const reads: PropertyKey[] = [];
    const context = new Proxy({} as MessagingBackendEventContext, {
      get: (_, key) => { reads.push(key); throw new Error(`Unexpected construction read: ${String(key)}`); },
    });
    new MessagingBackendEventRouter(context);
    expect(reads).toEqual([]);
  });

  it("uses the current host and store after an awaited queue outcome", async () => {
    const f = await fixture();
    const entered = gate();
    const release = gate();
    const effects: string[] = [];
    const original = f.backendEventHost();
    let host = {
      ...original,
      applySharedQueueNoticeEvent: async () => { effects.push("outcome"); entered.resolve(); await release.promise; },
      reconcileQueuedAgentMessagingOrigin: async () => { effects.push("old origin"); },
    };
    let store = f.store;
    const router = new MessagingBackendEventRouter({
      get store() { effects.push("store"); return store; },
      now: () => 1_000, logger: {}, host: () => host,
    });
    const event: AgentEvent = { backend: "codex", notification: { method: "thread/turnQueue/updated", params: {
      threadId: binding.threadId, queueEntryId: "entry", status: "started", turnId: "turn", origin: "messaging",
    } } };
    let handling: Promise<void> | undefined;
    try {
      handling = router.handleBackendEvent(event);
      await entered.promise;
      expect(effects).toEqual(["outcome"]);
      host = { ...host, reconcileQueuedAgentMessagingOrigin: async () => { effects.push("new origin"); } };
      // A wrapped store may replace its method while an event is awaiting.
      store = Object.create(f.store) as SqliteMessagingStore;
      store.findActiveBindingsForThread = async () => { effects.push("bindings"); return []; };
      release.resolve();
      await handling;
      expect(effects).toEqual(["outcome", "new origin", "store", "bindings"]);
    } finally {
      release.resolve();
      await handling;
      await f.close();
    }
  });

  it("tracks pending failed-event delivery without swallowing its exception", async () => {
    const f = await fixture();
    const entered = gate();
    const release = gate();
    const failure = new Error("Fixture delivery failure");
    const read = vi.spyOn(f.store, "findActiveBindingsForThread").mockImplementation(async () => {
      entered.resolve(); await release.promise; throw failure;
    });
    const event: AgentEvent = { backend: "codex", notification: { method: "turn/failed", params: {
      threadId: binding.threadId, turnId: "turn", turn: { id: "turn", status: "failed", error: { message: "Fixture" } },
    } } };
    const handling = f.backendEvents.handleBackendEvent(event);
    const rejection = expect(handling).rejects.toBe(failure);
    try {
      await entered.promise;
      let settled = false;
      const waiting = f.backendEvents.waitForPendingTurnFailureHandlers(binding).then(() => { settled = true; });
      await setImmediate();
      expect(settled).toBe(false);
      release.resolve();
      await rejection;
      await waiting;
      expect(settled).toBe(true);
      read.mockRestore();
      await f.backendEvents.waitForPendingTurnFailureHandlers(binding);
    } finally {
      release.resolve();
      await rejection;
      await f.close();
    }
  });

  it.each(["completed", "interrupted"] as const)("awaits terminal cleanup before activity (%s)", async (status) => {
    const f = await fixture();
    const entered = gate();
    const release = gate();
    const effects: string[] = [];
    const host = {
      ...f.backendEventHost(),
      flushToolUpdatesForBinding: async () => { effects.push("flush"); entered.resolve(); await release.promise; },
      finalizeWorkingCard: async () => { effects.push("card"); },
      clearTurnProse: () => { effects.push("prose"); },
      signalTurnActivity: async () => { effects.push("activity"); },
      renderAutomaticBindingStatus: async () => { effects.push("status"); return binding; },
      forgetAutomationTurn: () => { effects.push("automation origin"); },
      forgetAgentMessagingOrigin: () => { effects.push("messaging origin"); },
    };
    const router = new MessagingBackendEventRouter({ store: f.store, host: () => host, now: () => 1_000, logger: {} });
    let handling: Promise<void> | undefined;
    try {
      await f.store.upsertBinding(binding);
      handling = router.handleBackendEvent({ backend: "codex", notification: { method: "turn/completed", params: {
        threadId: binding.threadId, turnId: "turn", turn: { id: "turn", status, output: [] },
      } } });
      await entered.promise;
      await setImmediate();
      expect(effects).toEqual(["flush"]);
      release.resolve();
      await handling;
      // Successful turns do not force a status card; interruption does.
      expect(effects).toEqual(["flush", "card", "prose", "activity", ...(status === "interrupted" ? ["status"] : []), "automation origin", "messaging origin"]);
    } finally {
      release.resolve();
      await handling;
      await f.close();
    }
  });

  it("preserves early exits for private/transient activity and backend rate limits", async () => {
    const f = await fixture();
    const read = vi.spyOn(f.store, "findActiveBindingsForThread");
    try {
      await f.backendEvents.handleBackendEvent({ backend: "codex", notification: { method: "account/rateLimits/updated", params: { rateLimits: {} } } });
      await f.backendEvents.handleBackendEvent({ backend: "codex", notification: { method: "thread/subAgents/updated", params: { threadId: binding.threadId } } });
      expect(read).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
