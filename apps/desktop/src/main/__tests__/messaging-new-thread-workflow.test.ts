import { describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared";
import { MessagingNewThreadWorkflow } from "../messaging/core/messaging-new-thread-workflow";
import type { MessagingNewThreadContext } from "../messaging/core/messaging-new-thread-context";
import { readMessagingLaunchpadContext } from "../messaging/core/messaging-launchpad-context";
import { messagingModules } from "./fixtures/messaging-controller-modules";
import { messagingNewThreadHarness } from "./fixtures/messaging-new-thread-harness";

function contextFor(real: Awaited<ReturnType<typeof messagingNewThreadHarness>>): MessagingNewThreadContext {
  return { get store() { return real.controllerOptions.store; }, get backend() { return real.controllerOptions.backend; },
    capabilityProfile: real.controllerOptions.adapter.capabilityProfile, pendingIntentTtlMs: 1_000, streamingResponsesDefault: false,
    now: real.controllerOptions.now ?? Date.now, logger: real.controllerOptions.logger ?? {}, host: messagingModules(real.controller).newThreadHost };
}

describe("messaging new-thread owner ports", () => {
  it("constructs without reading collaborators and uses the latest clock", async () => {
    const real = await messagingNewThreadHarness();
    try {
      await real.open();
      const actual = contextFor(real); const reads: string[] = []; let now = () => 1_000;
      const owner = new MessagingNewThreadWorkflow({
        get store() { reads.push("store"); return actual.store; }, get backend() { reads.push("backend"); return actual.backend; },
        get capabilityProfile() { reads.push("capabilities"); return actual.capabilityProfile; },
        get pendingIntentTtlMs() { reads.push("ttl"); return actual.pendingIntentTtlMs; },
        get streamingResponsesDefault() { reads.push("streaming"); return actual.streamingResponsesDefault; },
        get now() { reads.push("now"); return now; }, get logger() { reads.push("logger"); return actual.logger; },
        get host() { reads.push("host"); return actual.host; },
      });
      expect(reads).toEqual([]);
      now = () => 1_000_000;
      const session = (await real.session())!;
      const updated = owner.withNewThreadPromptCaptureExpiry(session);
      expect(updated.expiresAt).toBeGreaterThan(session.expiresAt);
      expect(updated.textInputExpiresAt).toBe(updated.expiresAt);
      expect(reads).toEqual(["now"]);
    } finally { await real.close(); }
  });

  it("preserves the controller clock receiver through the actual lazy port", async () => {
    const receivers: unknown[] = [];
    const real = await messagingNewThreadHarness({ clock: function (this: unknown) { receivers.push(this); return 1_000; } });
    try {
      await real.open(); receivers.length = 0;
      messagingModules(real.controller).newThreads.withNewThreadPromptCaptureExpiry((await real.session())!);
      expect(receivers.length).toBeGreaterThan(0);
      expect(receivers.every(receiver => receiver === real.controller)).toBe(true);
    } finally { await real.close(); }
  });

  it("reads the replacement wrapped store for both session and surface writes", async () => {
    const real = await messagingNewThreadHarness();
    try {
      await real.open(); let store = real.controllerOptions.store;
      const owner = new MessagingNewThreadWorkflow({ ...contextFor(real), get store() { return store; } });
      const calls: string[] = [];
      store = new Proxy(real.store, { get(target, property) {
        if (property === "upsertBrowseSession") return async (...args: Parameters<typeof target.upsertBrowseSession>) => {
          calls.push("session"); return target.upsertBrowseSession(...args);
        };
        if (property === "upsertPendingIntent") return async (...args: Parameters<typeof target.upsertPendingIntent>) => {
          calls.push("pending"); return target.upsertPendingIntent(...args);
        };
        const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
      } });
      const before = (await real.session())!;
      real.controllerOptions.store = store;
      await messagingModules(real.controller).newThreads.presentNewThreadPromptGate(before, real.event());
      expect(calls).toEqual(["session", "pending", "session", "pending"]);
      calls.length = 0;
      await owner.presentNewThreadPromptGate(before, real.event());
      expect(calls).toEqual(["session", "pending", "session", "pending"]);
      expect((await real.session())?.surface).not.toEqual(before.surface);
    } finally { await real.close(); }
  });

  it("keeps discovery getters inside their catch and sticky prechecks outside it", async () => {
    const real = await messagingNewThreadHarness();
    try {
      await real.open(); const debug = vi.fn();
      const owner = new MessagingNewThreadWorkflow({ ...contextFor(real), logger: { debug }, backend: {
        get listBackends(): NonNullable<MessagingNewThreadContext["backend"]["listBackends"]> { throw new Error("Fixture list getter"); },
        get updateDirectoryLaunchpad(): NonNullable<MessagingNewThreadContext["backend"]["updateDirectoryLaunchpad"]> { throw new Error("Fixture sticky getter"); },
      } });
      await expect(owner.loadNewThreadBackendChoices(real.event())).resolves.toBeUndefined();
      expect(debug).toHaveBeenCalledWith("messaging new-thread backend discovery failed", { error: "Fixture list getter" });
      await expect(owner.updateNewThreadStickySettings((await real.session())!, { model: "fixture" })).rejects.toThrow("Fixture sticky getter");
    } finally { await real.close(); }
  });

  it("keeps remote choices local without reading the local sticky-write getter", async () => {
    const real = await messagingNewThreadHarness();
    try {
      await real.open(); const actual = contextFor(real);
      const owner = new MessagingNewThreadWorkflow({ ...actual, backend: {
        get updateDirectoryLaunchpad(): NonNullable<MessagingNewThreadContext["backend"]["updateDirectoryLaunchpad"]> { throw new Error("Local write must not be read"); },
      } });
      const session = (await real.session())!;
      await expect(owner.updateNewThreadStickySettings({ ...session, selectedProject: { ...session.selectedProject!,
        federationTarget: { scope: "remote", instanceId: "fixture-peer" } } }, { model: "fixture" })).resolves.toBeUndefined();
      expect(real.sticky).toEqual([]);
    } finally { await real.close(); }
  });

  it("does not write or apply an explicit Full Access selection before the gate accepts", async () => {
    const real = await messagingNewThreadHarness();
    try {
      await real.open(); const session = (await real.session())!;
      const navigation = await readMessagingLaunchpadContext({ backend: real.backend, project: session.selectedProject });
      await messagingModules(real.controller).newThreads.setNewThreadPermissions(session,
        { ...real.event(), kind: "callback", actionId: "browse:new:set-permissions", value: { executionMode: "full-access" },
          interaction: { channel: real.channel.channel, id: "fixture-interaction" } }, navigation);
      expect(real.sticky).toEqual([]);
      expect((await real.session())?.preferences?.executionMode).not.toBe("full-access");
      expect(real.requests).toEqual([]);
    } finally { await real.close(); }
  });

  it("requires the runtime risk gate before applying a privileged ACP choice", async () => {
    const real = await messagingNewThreadHarness();
    try {
      await real.open(); const actual = contextFor(real); const gate = vi.fn(async () => false);
      const base = (await real.backend.listBackends!()).backends[0]!;
      const summary: BackendSummary = { ...base, kind: "acp:grok", executionModes: [{ mode: "default", label: "Default", available: true }],
        acp: { registryId: "fixture", distributionKinds: [], installStatus: "installed", authStatus: "authenticated", verificationStatus: "verified",
          runtime: { schemaVersion: 1, status: "discovered", modes: { currentModeId: "default",
            availableModes: [{ id: "default", label: "Default" }, { id: "yolo", label: "Full Access" }] } } } };
      const owner = new MessagingNewThreadWorkflow({ ...actual, host: () => ({ ...actual.host(), getBackendSummary: async () => summary, ensureAcpRuntimeModeAllowed: gate }) });
      const session = { ...(await real.session())!, backend: "acp:grok" as const };
      const navigation = await readMessagingLaunchpadContext({ backend: real.backend, project: session.selectedProject });
      await owner.setNewThreadAcpRuntimeMode(session, { ...real.event(), kind: "callback", actionId: "browse:new:set-runtime-mode",
        value: { source: "mode", optionId: "mode", value: "yolo" }, interaction: { channel: real.channel.channel, id: "fixture-interaction" } }, navigation);
      expect(gate).toHaveBeenCalledWith({ kind: "new-thread", label: "Full Access", optionId: "mode", sessionId: session.id, source: "mode", value: "yolo" }, expect.anything());
      expect(real.sticky).toEqual([]);
      expect((await real.session())?.preferences?.acpRuntime).toBeUndefined();
    } finally { await real.close(); }
  });
});
