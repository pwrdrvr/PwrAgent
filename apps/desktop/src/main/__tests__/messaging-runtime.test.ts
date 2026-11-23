import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, StartTurnRequest } from "@pwragent/shared/contracts/agent";
import type { FederationEventSubscription } from "@pwragent/shared/contracts/federation";
import type { NavigationSnapshot } from "@pwragent/shared/contracts/navigation";
import type {
  MessagingChannelKind,
  MessagingAuthorizationRejection,
  MessagingDeliveryResult,
  MessagingDeliveryScope,
  MessagingAdapterDiagnosticListener,
  MessagingInboundEvent,
  MessagingInboundRejectedListener,
  MessagingRateLimitInfo,
  MessagingReconnectInfo,
  MessagingRejectedInboundEvent,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import { boundedMessagingNavigation } from "./fixtures/bounded-messaging-navigation";
import type { MessagingControllerDeliveryBudgetEvent } from "../messaging/core/messaging-controller";
import type {
  DesktopMessagingConfig,
  DesktopMessagingFullAccessControls,
} from "../messaging/messaging-config";
import type {
  DesktopMessagingAdapter,
  DesktopMessagingAdapterFactory,
  DesktopMessagingConfigLoader,
  DesktopMessagingRuntime,
  MessagingAutomationInboundHandler,
  MessagingAutomationInboundMatcher,
} from "../messaging/messaging-runtime";

const messagingLog = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};
const evaluatedModuleLoggers = new Set<string>();

vi.mock("../log", () => ({
  getMainLogger: vi.fn((name: string) => {
    evaluatedModuleLoggers.add(name);
    return messagingLog;
  }),
}));

// This file does not call `StateDb.open`; `initializeAppState` opens the
// profile database for it, once per test, and `migrateIfNeeded` opens it a
// second time on the way there. Both are incidental to what is tested here,
// and the two mocks below take all 148 of those file opens out of the run.
//
// Migration can only ever report `fresh-install` against the throwaway
// `PWRAGENT_HOME` each test stubs, so nothing is lost by skipping it, and
// `state-migration.test.ts` owns that behaviour. Note that `fresh-install`
// still opens the database file before handing back its path: skipping
// migration is what removes those 74 opens, so this mock keeps earning its
// place no matter where the legacy search roots point.
//
// It is skipped rather than redirected for a second reason, historical now:
// `findLegacyPaths` resolved its legacy search roots from the real home
// directory rather than the stub, so on a machine carrying pre-1.0 PwrAgent
// state these tests re-migrated the operator's own messaging and overlay
// JSON 74 times a run. #2171 fixed that for every desktop suite by seeding
// the XDG variables in `vitest.workspace.mts`; redirecting migration at a
// `:memory:` path here would have written a file literally named
// `:memory:.tmp`, which is why this mock does not try.
vi.mock("../state/migration", () => ({
  migrateIfNeeded: () => ({ status: "already-migrated" }),
}));

// Only `app-state` and `migration` ask for "state/state.db"; every other
// caller of `resolveActiveProfilePath` asks for a different relative path and
// still lands inside the stubbed profile directory.
let useFileBackedStateDb = false;
vi.mock("../profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../profile")>();
  return {
    ...actual,
    resolveActiveProfilePath: (
      relativePath: Parameters<typeof actual.resolveActiveProfilePath>[0],
      options?: Parameters<typeof actual.resolveActiveProfilePath>[1],
    ) =>
      relativePath === "state/state.db" && !useFileBackedStateDb
        ? ":memory:"
        : actual.resolveActiveProfilePath(relativePath, options),
  };
});

const tempDirs: string[] = [];
const activeRuntimes: DesktopMessagingRuntime[] = [];
const disposeConnectionFixtures: Array<() => void> = [];
// Collection owns the cold transform/evaluation of this integration graph.
// Keep no exports here: afterEach resets the module cache, so each hook must
// import its own generation before constructing that test's federation owner.
await import("../federation/federation-runtime");

// The real module's top-level logger records evaluation, independently of
// how long a particular runner takes to load its dependency graph.
const federationEvaluatedDuringCollection = evaluatedModuleLoggers.has("pwragent:federation-runtime");

function trackRuntime(runtime: DesktopMessagingRuntime): DesktopMessagingRuntime {
  activeRuntimes.push(runtime);
  return runtime;
}

beforeEach(async () => {
  const { initializeDesktopFederationRuntime } = await import("../federation/federation-runtime");
  initializeDesktopFederationRuntime();
  messagingLog.debug.mockReset();
  messagingLog.error.mockReset();
  messagingLog.info.mockReset();
  messagingLog.warn.mockReset();
});

afterEach(async () => {
  // Stop runtimes and let their async rehydration (microtask-chained
  // synchronous better-sqlite3 writes) settle BEFORE the app-state DB is
  // closed. Otherwise trailing writes hit a closed connection and surface as
  // unhandled "database connection is not open" rejections that fail the run
  // even though every test passed.
  await Promise.all(
    activeRuntimes.splice(0).map((runtime) => runtime.stop().catch(() => {})),
  );
  await flushMicrotasks();
  // The fixture deletes the profile on teardown. Windows requires every
  // connection database handle to be closed before unlinking its file.
  for (const dispose of disposeConnectionFixtures.splice(0)) dispose();
  const { resetAppStateForTests } = await import("../state/app-state");
  resetAppStateForTests();
  useFileBackedStateDb = false;
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await rm(tempDir, { recursive: true, force: true });
    }),
  );
});

describe("DesktopMessagingRuntime", () => {
  it("does not restore an obsolete named registration from an older queued configuration", async () => {
    await prepareRuntimeStore();
    const { DesktopMessagingRuntime: Runtime } = await import("../messaging/messaging-runtime");
    const factoryStarted = createDeferred<void>();
    const releaseFactory = createDeferred<void>();
    const named = {
      channel: "telegram" as const, botToken: "123:fixture", expectedBotAccountId: "123",
      configuredConnectionId: `mc_${"a".repeat(32)}`, authorizedActorIds: [],
    };
    const namedFactory = vi.fn(() => []);
    const runtime = trackRuntime(new Runtime({
      adapterFactory: async ({ config }) => {
        if (config.inputDebounceMs === 1) {
          factoryStarted.resolve();
          await releaseFactory.promise;
        }
        return config.telegram?.configuredConnectionId ? namedFactory() : [];
      },
      backendBridge: createBackendBridge(),
      config: {},
    }));
    const before = runtime.applyConfig({ inputDebounceMs: 1 });
    await factoryStarted.promise;
    const queued = runtime.applyConfig({ telegramConnections: [named] });
    const removed = runtime.applyConfig({ telegramConnections: [] });
    releaseFactory.resolve();
    await Promise.all([before, queued, removed]);
    expect(namedFactory).not.toHaveBeenCalled();
  });

  it("only admits observed messages for the verified running Telegram connection", async () => {
    await prepareRuntimeStore();
    const storage = await import("../storage/desktop-messaging-storage");
    const openConnectionStorage = storage.openMessagingConnectionStorage;
    const connections: Array<ReturnType<typeof openConnectionStorage>> = [];
    const openFixture = vi.spyOn(storage, "openMessagingConnectionStorage").mockImplementation((id) => {
      const connection = openConnectionStorage(id);
      connections.push(connection);
      return connection;
    });
    disposeConnectionFixtures.push(() => {
      openFixture.mockRestore();
      for (const connection of connections) connection.close();
    });
    const { DesktopMessagingRuntime: Runtime } = await import("../messaging/messaging-runtime");
    const { buildSourceEventKey } = await import("../automations/automation-trigger-matcher");
    const seen = vi.fn(async () => true);
    const adapterA = createAdapter("telegram", { readVerifiedBotAccountId: () => "111" });
    let notifyFailure: ((reason: string) => void) | undefined;
    const adapterB = createAdapter("telegram", {
      readVerifiedBotAccountId: () => "222", authorizedActorIds: [],
      onRuntimeError: (notify) => { notifyFailure = notify; return () => { notifyFailure = undefined; }; },
    });
    const unverified = createAdapter("telegram", { readDmPairingAccountId: () => "222" });
    const [idA, idB] = ["a", "b"].map((char) => `mc_${char.repeat(32)}`);
    const named = [idA, idB].map((id, index) => ({
      channel: "telegram" as const, botToken: `${index}:fixture`, configuredConnectionId: id,
      expectedBotAccountId: index === 0 ? "111" : "222",
      authorizedActorIds: [],
    }));
    const runtime = trackRuntime(new Runtime({
      adapterFactory: ({ config }) => {
        if (config.telegram?.configuredConnectionId === idA) return [adapterA];
        if (config.telegram?.configuredConnectionId === idB) {
          return [config.telegram.botToken === "broken" ? unverified : adapterB];
        }
        return [];
      },
      backendBridge: createBackendBridge(),
      config: { telegramConnections: named },
      automationInboundMatches: () => true,
      automationInboundHandler: seen,
    }));
    const onStatus = vi.fn();
    runtime.onPlatformStatus(onStatus);
    await runtime.start();
    expect(openFixture.mock.calls).toEqual([[idA], [idB]]);
    const send = async (adapter: typeof adapterA, connectionId?: string) => {
      await adapter.listener?.({
        id: "same-update", kind: "text", text: "Fixture", observedOnly: true,
        actor: { platformUserId: "user-1" },
        channel: { channel: "telegram", connectionId, conversation: { kind: "dm", id: "user-1" } },
        receivedAt: 1,
      });
    };
    await send(adapterA);
    await send(adapterA, idB);
    await send(adapterB, idA);
    expect(seen).not.toHaveBeenCalled();
    await send(adapterA, idA);
    await send(adapterB, idB);
    const events = seen.mock.calls as unknown as Array<[MessagingInboundEvent]>;
    expect(events.map(([event]) => event.channel.connectionId)).toEqual([idA, idB]);
    expect(new Set(events.map(([event]) => buildSourceEventKey(event))).size).toBe(2);
    for (const [adapter, connectionId] of [[adapterA, idA], [adapterB, idB]] as const) {
      await adapter.listener?.({
        id: "same-help", kind: "command", command: "help", args: [], rawText: "/help",
        actor: { platformUserId: "user-1" },
        channel: { channel: "telegram", connectionId, conversation: { kind: "dm", id: "user-1" } },
        receivedAt: 2,
      });
    }
    expect(adapterA.delivered.length).toBeGreaterThan(0);
    expect(adapterA.delivered.some((intent) => intent.id.startsWith("unauthorized"))).toBe(false);
    expect(adapterB.delivered.some((intent) => intent.id.startsWith("unauthorized"))).toBe(true);
    expect(adapterA.delivered.map((intent) => intent.audit?.channel.connectionId)).toEqual(
      adapterA.delivered.map(() => idA),
    );
    expect(runtime.generatePairingToken({ platform: "telegram", scope: "user_dm", connectionId: idA }).entry)
      .toMatchObject({ connectionId: idA, instanceId: "account:111" });
    expect(runtime.listPairingRequests({ connectionId: idB }).entries).toEqual([]);
    notifyFailure?.("Fixture polling failure");
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
      kind: "connection-health-changed", connectionId: idB,
    }));
    expect(runtime.getTelegramConnectionHealth(idB)?.health).toBe("errored");

    await runtime.applyConfig({ telegramConnections: [named[0], { ...named[1], botToken: "broken" }] });
    await send(unverified, idB);
    expect(() => runtime.generatePairingToken({ platform: "telegram", scope: "user_dm", connectionId: idB }))
      .toThrow(/Connect this Telegram bot/);
    await runtime.applyConfig({ telegramConnections: [named[0]] });
    await send(adapterB, idB);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(() => runtime.listPairingRequests({ connectionId: idB })).toThrow(/unavailable/);
  });

  it("rehydrates exact Telegram bindings and callbacks while the legacy database sees only singleton rows", async () => {
    await prepareRuntimeStore();
    const { openMessagingConnectionStorage } = await import("../storage/desktop-messaging-storage");
    const { getDesktopMessagingStore } = await import("../messaging/desktop-messaging-store");
    const scopes = [undefined, `mc_${"a".repeat(32)}`, `mc_${"b".repeat(32)}`];
    const channel = (connectionId: string | undefined) => ({
      channel: "telegram" as const,
      ...(connectionId === undefined ? {} : { connectionId }),
      conversation: { id: "10", kind: "topic" as const, parentId: "-1000123" },
    });
    for (const [index, id] of scopes.entries()) {
      const scoped = id === undefined ? undefined : openMessagingConnectionStorage(id);
      const store = scoped?.bindings ?? getDesktopMessagingStore();
      try {
        const binding = {
          id: "same-binding-id", channel: channel(id), backend: "codex" as const, threadId: `thread-${index}`,
          authorizedActorIds: ["same-actor"], createdAt: 1, updatedAt: 1,
        };
        await store.upsertBinding(binding);
        await store.upsertCallbackHandle({
          id: "same-handle-id", channel: channel(id), handle: "same-button", actionId: `action-${index}`,
          bindingId: binding.id, allowedActorIds: ["same-actor"], createdAt: 1, updatedAt: 1, expiresAt: 100,
        });
      } finally {
        scoped?.close();
      }
    }
    for (const [index, id] of scopes.entries()) {
      const reopened = id === undefined ? undefined : openMessagingConnectionStorage(id);
      const store = reopened?.bindings ?? getDesktopMessagingStore();
      try {
        expect((await store.findActiveBindings()).map((row) => row.channel.connectionId)).toEqual([id]);
        for (const queried of scopes) {
          const ref = channel(queried);
          expect((await store.findActiveBindingForChannel(ref))?.threadId).toBe(queried === id ? `thread-${index}` : undefined);
          expect((await store.resolveCallbackHandle({ actorId: "same-actor", channel: ref, handle: "same-button", now: 3 }))?.actionId)
            .toBe(queried === id ? `action-${index}` : undefined);
        }
      } finally {
        reopened?.close();
      }
    }
  });

  // Rule: a run a restart interrupted reaches each bound conversation once,
  // whether the automation service published it before the channel started
  // (startup reports it from `automations.start()`, before messaging) or while
  // the channel was listening. A channel restart does not post it again.
  it("delivers each interrupted automation run to a bound conversation exactly once", async () => {
    type Step = "publish" | "start" | "stop";
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Step>("publish", "start", "stop"), {
          minLength: 1,
          maxLength: 12,
        }),
        async (steps) => {
          await prepareRuntimeStore();
          const { getDesktopMessagingStore } = await import(
            "../messaging/desktop-messaging-store"
          );
          await getDesktopMessagingStore().upsertBinding({
            id: "binding-1",
            backend: "codex",
            threadId: "thread-1",
            targetKind: "thread",
            channel: { channel: "telegram", conversation: { id: "chat-1", kind: "dm" } },
            authorizedActorIds: ["user-1"],
            createdAt: 1000,
            updatedAt: 1000,
          });
          const adapter = createAdapter("telegram");
          const bridge = createBackendBridge();
          const published: AgentEvent[] = [];
          const { DesktopMessagingRuntime: Runtime } = await import(
            "../messaging/messaging-runtime"
          );
          const runtime = new Runtime({
            adapterFactory: () => [adapter],
            backendBridge: bridge,
            config: {
              inputDebounceMs: 0,
              telegram: {
                channel: "telegram",
                botToken: "telegram-token",
                authorizedActorIds: [{ id: "user-1", displayName: "" }],
              },
            },
            interruptedAutomationRunUpdates: () => published,
          });
          // Model: which runs must arrive, and which may be lost because
          // the operator had messaging stopped when they were published.
          const mustArrive = new Set<string>();
          let running = false;
          let everStarted = false;
          try {
            for (const step of [...steps, "start" as const]) {
              if (step === "start" && !running) {
                await runtime.start();
                running = true;
                everStarted = true;
              } else if (step === "stop" && running) {
                await runtime.stop();
                running = false;
              } else if (step === "publish") {
                const runId = `run-${published.length + 1}`;
                const event: AgentEvent = {
                  backend: "codex",
                  notification: {
                    method: "automation/run/updated",
                    params: {
                      threadId: "thread-1",
                      automationId: "automation-1",
                      automationName: "Check weather",
                      errorMessage: `PwrAgent stopped before ${runId} finished.`,
                      failureReason: "interrupted",
                      runId,
                      status: "failed",
                    },
                  },
                };
                // The service records the update before publishing it.
                published.push(event);
                if (running || !everStarted) mustArrive.add(runId);
                await bridge.emitBackendEvent(event);
              }
            }
            for (let index = 0; index < 5; index += 1) {
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            const notices = adapter.delivered.flatMap((intent) =>
              intent.kind === "message"
                ? intent.parts.map((part) => ("text" in part ? part.text : ""))
                : []);
            for (let index = 1; index <= published.length; index += 1) {
              const runId = `run-${index}`;
              const count = notices.filter((text) => text === (
                `Automation interrupted: Check weather · PwrAgent stopped before ${runId} finished.`
              )).length;
              // Never twice; exactly once unless messaging was stopped.
              expect({ runId, count }).toEqual({
                runId,
                count: mustArrive.has(runId) ? 1 : Math.min(count, 1),
              });
            }
          } finally {
            await runtime.stop().catch(() => {});
            await flushMicrotasks();
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it.each([false, true])("the authenticated execution owner can list only its admitted originals after restart (Slack first: %s)", async (slackFirst) => {
    const { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } = await import("../state/sqlite-write-metrics");
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    await prepareRuntimeStore();
    let authorized = true;
    let member = true;
    const telegramAuthorization = vi.fn(() => true);
    const telegram = createAdapter("telegram", { retainedSourceConnectionId: () => "telegram-fixture",
      authorizeRetainedSource: telegramAuthorization });
    const slack = createAdapter("slack", { retainedSourceConnectionId: () => "slack-fixture",
      authorizeRetainedSource: (_event, verifyAccess = true) => authorized && (!verifyAccess || member),
      downloadAttachment: async () => ({ data: Buffer.from("synthetic original"), fileName: "../archive.zip", sizeBytes: 18 }) });
    const bridge = createBackendBridge();
    const event = { ...buildTextEvent("Save"), kind: "media" as const, text: "Save", botMention: true,
      receivedAt: Date.now(), disposition: "available" as const,
      channel: { channel: "slack" as const, conversation: { id: "C4", kind: "channel" as const, workspaceId: "T1" } },
      attachments: [{ id: "private-id", name: "../archive.zip", kind: "file" as const, disposition: "available" as const }] };
    const { getDesktopMessagingStore } = await import("../messaging/desktop-messaging-store");
    const binding = { id: "remote-originals", backend: "codex" as const, threadId: "thread-1",
      targetKind: "thread" as const, channel: event.channel, authorizedActorIds: ["user-1"], createdAt: 1000, updatedAt: 1000,
      federatedThread: { backend: "codex" as const, threadId: "thread-1", target: { scope: "remote" as const, instanceId: "execution-owner" } } };
    await getDesktopMessagingStore().upsertBinding(binding);
    const { DesktopMessagingRuntime: Runtime } = await import("../messaging/messaging-runtime");
    const runtime = trackRuntime(new Runtime({ adapterFactory: () => slackFirst ? [slack, telegram] : [telegram, slack], backendBridge: bridge,
      config: { inputDebounceMs: 0,
        telegram: { channel: "telegram", botToken: "synthetic", authorizedActorIds: [{ id: "user-1", displayName: "" }] },
        slack: { channel: "slack", appToken: "synthetic", botToken: "synthetic", signingSecret: "synthetic",
          authorizedActorIds: [{ id: "user-1", displayName: "" }] } } }));
    await runtime.start();
    await slack.listener!(event);
    expect(bridge.startTurn).toHaveBeenCalledTimes(1);
    const context = { backend: "codex" as const, threadId: "thread-1", turnId: "completion",
      causalMessagingSource: vi.mocked(bridge.startTurn).mock.calls[0]![0].messageOrigin?.causalMessagingSource };
    expect(context.causalMessagingSource).toBeDefined();
    const { handleFederationMessagingDestination: handle } = await import("../federation/federation-messaging-tools");
    const profileSettingsCheck = {
      ...context, category: "messaging_context" as const, tool: "set_messaging_working_updates_default",
    };
    expect(await handle({ kind: "authorize", context, check: profileSettingsCheck }, "execution-owner"))
      .toEqual({ allowed: false, permission: "tools.messaging_profile_settings" });
    expect(await runtime.authorizeRetainedTool({
      ...context, causalMessagingSource: { ...context.causalMessagingSource!, instanceId: "peer-profile" },
    }, profileSettingsCheck)).toEqual({ allowed: false, permission: "tools.messaging_profile_settings" });
    const list = () => handle({ kind: "request", request: { operation: "list_messaging_attachments", context, args: {} } }, "execution-owner");
    // Owner oracle: admission into this exact remote binding is the grant,
    // independent of a colliding local ID, adapter order or process memory.
    expect(await list()).toMatchObject({ ok: true, data: { attachments: [{ name: "../archive.zip" }] } });
    await runtime.stop();
    await runtime.start();
    expect(await list()).toMatchObject({ ok: true });
    const { FederationMessagingAttachmentExports } = await import("../federation/federation-messaging-attachments");
    const transferRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-owner-original-export-"));
    tempDirs.push(transferRoot);
    const sourceOwner = context.causalMessagingSource!.instanceId!;
    let revokeMembershipAfterTransfer = false;
    let destination: InstanceType<typeof FederationMessagingAttachmentExports>;
    const owner = new FederationMessagingAttachmentExports({ directory: path.join(transferRoot, "provider-profile"),
      sendAllowed: () => true, receiveAllowed: () => false,
      rpc: () => ({ request: async <T,>(call: { params?: unknown }): Promise<T> => {
        const result = await destination.handle(sourceOwner, call.params, false) as T;
        if (revokeMembershipAfterTransfer && (call.params as { method?: string }).method === "file.push.finish") member = false;
        return result;
      } }) });
    destination = new FederationMessagingAttachmentExports({ directory: path.join(transferRoot, "execution-profile"),
      sendAllowed: () => false, receiveAllowed: () => true,
      rpc: () => ({ request: async <T,>(call: { params?: unknown }): Promise<T> =>
        await owner.handle("execution-owner", call.params, false) as T }) });
    const listed = await destination.request(sourceOwner, { operation: "list_messaging_attachments", context, args: {} });
    if (!listed.ok || !("attachments" in listed.data)) throw new Error("Expected remote originals");
    const attachmentId = listed.data.attachments[0]!.attachmentId;
    const exportRequest = { operation: "export_messaging_attachment" as const, context, args: { attachmentId } };
    const { result: exported, writes } = await measureSqliteWrites(async () =>
      await destination.request(sourceOwner, exportRequest));
    const { expectSqliteWriteBudget } = await import("./fixtures/sqlite-write-budget");
    expectSqliteWriteBudget({ scenario: "messaging-remote-original-export", writes,
      note: "One authenticated remote original export through restarted production messaging controllers and a destination receipt: 0 SQLite commits, 0 MB/day; source admission and fixture setup excluded." });
    if (!exported.ok || !("path" in exported.data)) throw new Error("Expected execution-local export");
    expect(await readFile(exported.data.path, "utf8")).toBe("synthetic original");
    expect(exported.data.path.startsWith(path.join(transferRoot, "execution-profile"))).toBe(true);
    revokeMembershipAfterTransfer = true;
    expect(await destination.request(sourceOwner, exportRequest)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    member = true;
    revokeMembershipAfterTransfer = false;
    // No legacy destination request can expose a provider-owner path.
    expect(await handle({ kind: "request", request: exportRequest }, "execution-owner"))
      .toMatchObject({ ok: false, error: { code: "unsupported_operation" } });
    for (const changed of [{ backend: "claude" as const }, { threadId: "other-thread" },
      { causalMessagingSource: { ...context.causalMessagingSource!, ownerId: "another-profile" } },
      { causalMessagingSource: { ...context.causalMessagingSource!, requestId: "another-human-request" } }]) {
      expect(await handle({ kind: "request", request: { operation: "list_messaging_attachments", context: { ...context, ...changed }, args: {} } }, "execution-owner"))
        .toMatchObject({ ok: false });
    }
    expect(await handle({ kind: "request", request: { operation: "list_messaging_attachments", context, args: {} } }, "other-peer"))
      .toMatchObject({ ok: false });
    expect(await destination.request(sourceOwner, { ...exportRequest, args: { attachmentId: "f".repeat(64) } }))
      .toMatchObject({ ok: false, error: { code: "not_found" } });
    const { getRbacPolicyService } = await import("../messaging/rbac-policy-service");
    const policy = getRbacPolicyService();
    const subject = { kind: "actor" as const, platform: "slack" as const, actorId: "user-1" };
    policy.setEnforced(true, [{ subject, roleIds: ["admin"] }]);
    expect(await list()).toMatchObject({ ok: true });
    policy.upsertAttachment({ subject, roleIds: [] });
    expect(await list()).toMatchObject({ ok: false });
    expect(await destination.request(sourceOwner, exportRequest)).toMatchObject({ ok: false });
    policy.setEnforced(false);
    authorized = false;
    expect(await list()).toMatchObject({ ok: false });
    expect(await destination.request(sourceOwner, exportRequest)).toMatchObject({ ok: false });
    authorized = true;
    await getDesktopMessagingStore().upsertBinding({ ...binding, federatedThread: { ...binding.federatedThread,
      target: { scope: "remote", instanceId: "other-peer" } } });
    expect(await list()).toMatchObject({ ok: false });
    await destination.reset();
    expect(telegramAuthorization).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude", "acp:gemini"] as const)("retains and exports general files through the production %s owner wiring", async (backend) => {
    await prepareRuntimeStore();
    const data = Buffer.from([0, 1, 2, 3, 255]);
    const adapter = createAdapter("telegram", {
      authorizedActorIds: ["user-1", "user-2"],
      downloadAttachment: async ({ attachment }) => ({ data, fileName: attachment.name,
        mimeType: "application/zip", sizeBytes: data.length }),
    });
    const bridge = createBackendBridge();
    const navigation = buildNavigationSnapshot();
    navigation.threads[0]!.source = backend;
    bridge.readNavigationFixturePopulation = vi.fn(async () => navigation);
    const { getDesktopMessagingStore } = await import("../messaging/desktop-messaging-store");
    await getDesktopMessagingStore().upsertBinding({ id: "originals-binding", backend, threadId: "thread-1",
      targetKind: "thread", channel: buildTextEvent("").channel, authorizedActorIds: ["user-1"], createdAt: 1000, updatedAt: 1000 });
    const { DesktopMessagingRuntime: Runtime } = await import("../messaging/messaging-runtime");
    const runtime = trackRuntime(new Runtime({ adapterFactory: () => [adapter], backendBridge: bridge,
      config: { inputDebounceMs: 0, telegram: { channel: "telegram", botToken: "synthetic-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }, { id: "user-2", displayName: "" }] } } }));
    await runtime.start();
    await adapter.listener!({ ...buildTextEvent("Save the archive"), kind: "media", text: "Save the archive",
      receivedAt: Date.now(),
      disposition: "available", attachments: [
        { id: "private-provider-id", name: "archive.zip", mimeType: "application/zip", kind: "file", disposition: "available" },
      ] });
    expect(bridge.startTurn).toHaveBeenCalledTimes(1);
    const request = vi.mocked(bridge.startTurn).mock.calls[0]![0];
    expect(request.input.some((item) => item.type === "text" && item.text.includes("export_messaging_attachment"))).toBe(true);
    const context = { backend, threadId: "thread-1", turnId: "turn-1" };
    const listed = await runtime.handlePwrAgentMessagingRequest({ operation: "list_messaging_attachments", context, args: {} });
    expect(listed).toMatchObject({ ok: true, data: { attachments: [{ name: "archive.zip", sizeBytes: data.length }] } });
    if (!listed.ok || !("attachments" in listed.data)) throw new Error("Expected originals");
    const attachmentId = listed.data.attachments[0]!.attachmentId;
    const exported = await runtime.handlePwrAgentMessagingRequest({ operation: "export_messaging_attachment", context, args: { attachmentId } });
    if (!exported.ok || !("path" in exported.data)) throw new Error("Expected export");
    expect(await readFile(exported.data.path)).toEqual(data);
    // Recreate controllers as on restart; another admitted actor must not gain
    // access to the previous actor's cached originals in this same thread.
    await runtime.stop();
    await runtime.start();
    await adapter.listener!({ ...buildTextEvent("Save a previous attachment"), id: "other-actor-event",
      actor: { platformUserId: "user-2" }, receivedAt: Date.now() });
    expect(await runtime.handlePwrAgentMessagingRequest({ operation: "export_messaging_attachment", context, args: { attachmentId } }))
      .toMatchObject({ ok: false, error: { code: "not_found" } });
    const { getDesktopFederationRuntime } = await import("../federation/federation-runtime");
    expect(await runtime.handlePwrAgentMessagingRequest({ operation: "export_messaging_attachment",
      context: { ...context, causalMessagingSource: { ownerId: "remote-profile", requestId: "remote-request",
        instanceId: `${getDesktopFederationRuntime().messagingSourceInstanceId()}_remote` } }, args: { attachmentId },
    })).toMatchObject({ ok: false, error: { code: "unsupported_operation", message: expect.stringContaining("messaging owner") } });
  });

  it("evaluates the real federation graph during collection before per-test owner setup", () => {
    expect(federationEvaluatedDuringCollection).toBe(true);
  });

  it("starts configured adapters and routes inbound events through channel controllers", async () => {
    const { runtime, adapter, bridge } = await createRuntimeHarness();

    await runtime.start();
    await adapter.listener?.(buildCommandEvent("/resume"));

    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(bridge.getNavigationQueryPage).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 2, consumer: "messaging-browse", pageSize: 8,
      query: expect.objectContaining({ kind: "messaging-threads" }),
    }));
    expect(bridge.getNavigationSnapshot).not.toHaveBeenCalled();
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "thread_picker",
    });
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await expect(getDesktopMessagingStore().findObservedSurfaces()).resolves
      .toEqual([
        expect.objectContaining({
          channel: expect.objectContaining({
            channel: "telegram",
            conversation: expect.objectContaining({ id: "chat-1" }),
          }),
        }),
      ]);
    // This integration-style startup test imports the runtime module graph and
    // exercises the full adapter-start + inbound-routing path. On the slow
    // shared Windows CI runner that cold path can exceed 15s — not a hang, just
    // slow — so Windows gets the workspace default headroom (30_000; see
    // vitest.workspace.mts). Other platforms keep the original tighter 15_000
    // budget where the cold path is comfortably fast, so a genuine hang or
    // regression there still fails fast instead of idling for the full 30s.
  }, process.platform === "win32" ? 30_000 : 15_000);

  it("requires a source-bound file receipt and authenticates the caller before dispatching outpost files", async () => {
    const { runtime } = await createRuntimeHarness();
    const { getDesktopFederationRuntime } = await import("../federation/federation-runtime");
    const federation = getDesktopFederationRuntime();
    vi.spyOn(federation, "messagingSourceInstanceId").mockReturnValue("pwr_provider_owner");
    const bytes = Buffer.from("%PDF-1.7 fixture");
    const consume = vi.spyOn(federation, "consumeMessagingFile").mockResolvedValue(bytes);
    const authorize = vi.spyOn(runtime, "authorizeRetainedTool").mockResolvedValue({ allowed: true });
    const dispatch = vi.spyOn(runtime, "handlePwrAgentMessagingRequest").mockResolvedValue({ ok: true, data: { attachments: [] } });
    const { handleFederationMessagingDestination: handle } = await import("../federation/federation-messaging-tools");
    const context = { backend: "codex" as const, threadId: "outpost-thread", turnId: "outpost-turn", requestingInstanceId: "forged-caller",
      causalMessagingSource: { ownerId: "profile-fixture", requestId: "request-fixture", instanceId: "pwr_provider_owner" } };
    const request = { operation: "send_messaging_file" as const, context, args: { path: "/owner/secret.pdf", filename: "report.pdf" } };
    expect(await handle({ kind: "request", request }, "pwr_outpost")).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(consume).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    const file = { path: "/receiver/acknowledged.bin", sizeBytes: bytes.length, sha256: "fixture-digest" };
    expect(await handle({ kind: "request", request, file }, "pwr_outpost")).toMatchObject({ ok: true });
    expect(consume).toHaveBeenCalledWith("pwr_outpost", file);
    expect(dispatch).toHaveBeenCalledWith({ ...request, context: { ...context, requestingInstanceId: "pwr_outpost", containedPeer: false }, args: { ...request.args, path: "" } }, bytes);
    authorize.mockResolvedValue({ allowed: false });
    expect(await handle({ kind: "request", request, file }, "pwr_outpost")).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(consume).toHaveBeenCalledTimes(1);
    consume.mockRestore(); authorize.mockRestore(); dispatch.mockRestore();
    vi.mocked(federation.messagingSourceInstanceId).mockRestore();
  });

  it("reports history only for implemented native conversation scopes", async () => {
    const adapter = Object.assign(createAdapter("slack"), { fetchRecentMessages: vi.fn(async () => []) });
    const { runtime } = await createRuntimeHarness({ adapter });
    await runtime.start();
    expect(runtime.supportsPreviewHistory("slack")).toBe(true);
    expect(runtime.supportsPreviewHistory("slack", { recipientUserId: "U012ABCDEF0" })).toBe(false);
    expect(runtime.supportsPreviewHistory("slack", { parentId: "1712023032.123456" })).toBe(false);
    for (const provider of ["telegram", "discord", "mattermost", "feishu", "line"] as const) {
      expect(runtime.supportsPreviewHistory(provider)).toBe(false);
    }
  });

  it("rejects provider events without a first-boundary receipt timestamp", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    await runtime.start();
    const invalidEvent = {
      ...buildCommandEvent("/resume"),
      receivedAt: undefined,
    } as unknown as MessagingInboundEvent;

    await expect(adapter.listener?.(invalidEvent)).rejects.toThrow(
      "omitted a finite first-boundary receivedAt",
    );
  });

  it("does not reload config to authorize an allowed Full Access bound reply", async () => {
    const config = buildFullAccessRuntimeConfig(true);
    let configLoadsAtStartTurn = -1;
    const loadConfig = vi.fn().mockResolvedValue(config);
    const { runtime, adapter, bridge } = await createFullAccessRuntimeHarness(
      loadConfig,
    );
    vi.mocked(bridge.startTurn).mockImplementation(async (request) => {
      configLoadsAtStartTurn = loadConfig.mock.calls.length;
      return {
        backend: request.backend,
        threadId: request.threadId,
        turnId: "turn-1",
      };
    });

    await runtime.start();
    await adapter.listener!(buildTextEvent("continue"));

    expect(bridge.startTurn).toHaveBeenCalledTimes(1);
    // Only the lifecycle read. This was 2 when the test was written, because
    // the PDF policy resolved on every inbound message; #1920 made that read
    // conditional on the event actually carrying an attachment, and this one
    // is plain text.
    expect(configLoadsAtStartTurn).toBe(1);
    const policy = messagingLog.info.mock.calls.find(
      (call) => call[0] === "messaging Full Access resume policy evaluated",
    );
    expect(policy?.[1]).toMatchObject({
      inboundEventId: "event-text",
      allowed: true,
      controlsSource: "runtime-snapshot",
      policyRevision: 1,
      fullAccessControlsLoadAwaitCount: 0,
      settingsConfigReadMs: 0,
      settingsConfigReadAwaitCount: 0,
      authorizedUserPolicyCheckAwaitCount: 0,
      allowedPathAuditPersistenceAwaitCount: 0,
    });
  });

  it("denies a Full Access bound reply from the applied runtime policy", async () => {
    const { runtime, adapter, bridge } = await createFullAccessRuntimeHarness(
      buildFullAccessRuntimeConfig(false),
    );

    await runtime.start();
    await adapter.listener!(buildTextEvent("continue"));

    expect(bridge.startTurn).not.toHaveBeenCalled();
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Full Access blocked",
      body: expect.stringContaining("cannot be resumed"),
    });
  });

  it("applies a hot Full Access resume policy change without restarting adapters", async () => {
    const { runtime, adapter, bridge } = await createFullAccessRuntimeHarness(
      buildFullAccessRuntimeConfig(true),
    );
    await runtime.start();

    await runtime.applyConfig(buildFullAccessRuntimeConfig(false));
    await adapter.listener!(buildTextEvent("continue"));

    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(bridge.startTurn).not.toHaveBeenCalled();
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Full Access blocked",
    });
  });

  it("fails closed after a lifecycle config read fails", async () => {
    const config = buildFullAccessRuntimeConfig(true);
    const loadConfig = vi.fn()
      .mockResolvedValueOnce(config)
      .mockRejectedValueOnce(new Error("settings unavailable"))
      // Keep the separately owned PDF setting read out of this policy test.
      .mockResolvedValue(config);
    const { runtime, adapter, bridge } = await createFullAccessRuntimeHarness(
      loadConfig,
    );
    await runtime.start();

    await expect(runtime.applyLatestConfig()).rejects.toThrow(
      "settings unavailable",
    );
    await adapter.listener!(buildTextEvent("continue"));

    expect(bridge.startTurn).not.toHaveBeenCalled();
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Full Access blocked",
    });
  });

  it("refreshes the cached contact after warning dismissal persists", async () => {
    const persisted = createDeferred<void>();
    const persistDismissal = vi.fn(async () => await persisted.promise);
    const config = buildFullAccessRuntimeConfig(true);
    config.fullAccessControls!.dismissWarning = persistDismissal;
    config.fullAccessControls!.canDismissWarning = () => true;
    const { runtime } = await createFullAccessRuntimeHarness(config);
    await runtime.start();
    const controller = (
      runtime as unknown as {
        controllers: Array<{
          options: {
            fullAccessControls: () =>
              | DesktopMessagingFullAccessControls
              | Promise<DesktopMessagingFullAccessControls>;
          };
        }>;
      }
    ).controllers[0]!;

    const before = await controller.options.fullAccessControls();
    expect(before.authorizedUsers.telegram?.[0]?.fullAccessWarningDismissed)
      .not.toBe(true);
    const dismissal = before.dismissWarning!({
      actorId: "user-1",
      channel: "telegram",
    });
    await flushMicrotasks();
    const whilePersisting = await controller.options.fullAccessControls();
    expect(
      whilePersisting.authorizedUsers.telegram?.[0]?.fullAccessWarningDismissed,
    ).not.toBe(true);
    persisted.resolve();
    await dismissal;
    const after = await controller.options.fullAccessControls();

    expect(persistDismissal).toHaveBeenCalledWith({
      actorId: "user-1",
      channel: "telegram",
    });
    expect(after.authorizedUsers.telegram?.[0]?.fullAccessWarningDismissed)
      .toBe(true);
  });

  it("subscribes only to federated bindings on running adapters", async () => {
    const { runtime, bridge } = await createRuntimeHarness();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:remote",
      channel: {
        channel: "telegram",
        conversation: { id: "chat-1", kind: "dm" },
      },
      backend: "codex",
      threadId: "thread-remote",
      federatedThread: {
        backend: "codex",
        target: { scope: "remote", instanceId: "owner_one" },
        threadId: "thread-remote",
      },
      authorizedActorIds: ["user-1"],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:inactive-discord",
      channel: {
        channel: "discord",
        conversation: { id: "discord-chat-1", kind: "dm" },
      },
      backend: "codex",
      threadId: "thread-inactive",
      federatedThread: {
        backend: "codex",
        target: { scope: "remote", instanceId: "owner_two" },
        threadId: "thread-inactive",
      },
      authorizedActorIds: ["user-1"],
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    await runtime.start();

    expect(bridge.setRemoteEventSubscriptions).toHaveBeenLastCalledWith([{
      sourceInstanceId: "owner_one",
      eventClasses: [
        "navigation",
        "transcript",
        "pending_requests",
        "scheduled_actions",
      ],
      threadSelection: {
        kind: "threads",
        threads: [{ backend: "codex", threadId: "thread-remote" }],
      },
    }]);

    await runtime.requestBindingRevoke({
      bindingId: "binding:remote",
      origin: "ui",
    });
    await vi.waitFor(() => {
      expect(bridge.setRemoteEventSubscriptions).toHaveBeenLastCalledWith([]);
    });

    await runtime.stop();
    expect(bridge.setRemoteEventSubscriptions).toHaveBeenLastCalledWith([]);
  });

  it("retains a rejected config application as a startup failure for every platform", async () => {
    await prepareRuntimeStore();
    const telegramAdapter = createAdapter("telegram");
    const discordAdapter = createAdapter("discord");
    const bridge = createBackendBridge();
    vi.mocked(bridge.setRemoteEventSubscriptions)
      .mockImplementationOnce(() => {
        throw new Error(
          "Cannot read properties of undefined (reading 'federation')",
        );
      });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: ({ config }) => [
        ...(config.telegram ? [telegramAdapter] : []),
        ...(config.discord ? [discordAdapter] : []),
      ],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }));

    await expect(runtime.start()).rejects.toThrow("reading 'federation'");
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health: "errored",
          platform: "telegram",
          startupFailure: true,
        }),
        expect.objectContaining({
          health: "errored",
          platform: "discord",
          startupFailure: true,
        }),
      ]),
    );

    await runtime.stop({ preserveStartupFailures: true });

    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health: "suspended",
          platform: "telegram",
          reason: "Cannot read properties of undefined (reading 'federation')",
          startupFailure: true,
        }),
        expect.objectContaining({
          health: "suspended",
          platform: "discord",
          reason: "Cannot read properties of undefined (reading 'federation')",
          startupFailure: true,
        }),
      ]),
    );

    await runtime.applyConfig({
      discord: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });

    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health: "suspended",
          platform: "telegram",
          reason: undefined,
          startupFailure: undefined,
        }),
        expect.objectContaining({
          health: "enabled",
          platform: "discord",
          startupFailure: undefined,
        }),
      ]),
    );

    vi.mocked(bridge.setRemoteEventSubscriptions)
      .mockImplementationOnce(() => {
        throw new Error("subscription refresh failed");
      });
    await expect(runtime.applyConfig({
      discord: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    })).rejects.toThrow("subscription refresh failed");

    await runtime.applyConfig({ enabled: false });

    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health: "suspended",
          platform: "discord",
          reason: undefined,
          startupFailure: undefined,
        }),
        expect.objectContaining({
          health: "suspended",
          platform: "telegram",
          startupFailure: undefined,
        }),
      ]),
    );
  });

  it("preserves the backend bridge receiver while syncing federation subscriptions", async () => {
    const { runtime, bridge } = await createRuntimeHarness();
    const subscriptions: FederationEventSubscription[][] = [];
    bridge.setRemoteEventSubscriptions = function (next) {
      expect(this).toBe(bridge);
      subscriptions.push([...next]);
    };

    await runtime.start();

    expect(subscriptions).toEqual([[]]);
  });

  it("rehydrates enabled Monitor bindings after adapter startup", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:telegram:dm::chat-1:codex:thread-1",
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "dm",
        },
      },
      backend: "codex",
      threadId: "thread-1",
      authorizedActorIds: ["user-1"],
      createdAt: 1000,
      updatedAt: 1000,
      monitor: {
        enabled: true,
        intervalMs: 1,
        updatedAt: 1000,
      },
    });

    await runtime.start();
    await waitFor(() => adapter.delivered.some((intent) => intent.kind === "status"));

    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Monitor: Recent threads"),
    });
  });

  // Windows-only skip: this is the channel-subscription twin of the binding
  // test above. Both arm a recurring 1ms monitor timer. The product change in
  // this PR (a `disposed` guard in MessagingController.scheduleMonitor*Tick)
  // stops a disposed controller from re-arming that timer, which is the root
  // cause of the lingering SQLite WAL handle that, on Windows, blocks the
  // afterEach temp-dir removal (POSIX can unlink open files, Windows cannot).
  // On the Windows CI runner this specific test still timed out at 5000ms in a
  // way that could not be reproduced or pinpointed from POSIX/static analysis
  // (the entire backend bridge + adapter are mocked and resolve synchronously,
  // so `runtime.start()` has no real I/O to block on). Until it can be
  // confirmed on a Windows box, skip it there rather than ship a speculative
  // product change beyond the dispose-guard. The binding twin above keeps the
  // rehydrate-on-startup path covered on every platform.
  it.skipIf(process.platform === "win32")("rehydrates enabled channel Monitor subscriptions after adapter startup", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertMonitorSubscription({
      id: "monitor:telegram:dm::chat-1",
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "dm",
        },
      },
      authorizedActorIds: ["user-1"],
      createdAt: 1000,
      updatedAt: 1000,
      monitor: {
        enabled: true,
        intervalMs: 1,
        updatedAt: 1000,
      },
    });

    await runtime.start();
    await waitFor(() => adapter.delivered.some((intent) => intent.kind === "status"));

    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Monitor: Recent threads"),
    });
  });

  it("surfaces adapter startup credential metadata in platform status", async () => {
    const { runtime } = await createRuntimeHarness({
      adapter: createAdapter("telegram", {
        readCredentialMetadata: () => ({
          account: "@pwragent_bot",
          detail: "api.telegram.org",
        }),
      }),
    });

    await runtime.start();

    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        account: "@pwragent_bot",
        detail: "api.telegram.org",
        health: "enabled",
        platform: "telegram",
      }),
    ]);
    expect(runtime.getPlatformCredentialMetadata("telegram")).toEqual(
      expect.objectContaining({
        account: "@pwragent_bot",
        detail: "api.telegram.org",
      }),
    );
  });

  it("routes adversarial Telegram inbound text literally without mutating SQLite state", async () => {
    const { runtime, adapter, bridge } = await createRuntimeHarness();
    const { getAppStateDb } = await import("../state/app-state");
    const stateDb = getAppStateDb();
    const adversarialText =
      "'; UPDATE meta SET value = 'pwned' WHERE key = 'sql_injection_sentinel'; DROP TABLE bindings; --\0"
      + "x".repeat(8_192);
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run("sql_injection_sentinel", "intact");

    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    await adapter.listener?.(buildTextEvent(adversarialText, {
      actorDisplayName: adversarialText,
      conversationTitle: adversarialText,
    }));

    expect(bridge.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ type: "text", text: adversarialText }],
      }),
    );
    expect(
      stateDb.raw
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get("sql_injection_sentinel"),
    ).toEqual({ value: "intact" });
    expect(
      stateDb.raw
        .prepare("SELECT COUNT(*) AS count FROM bindings WHERE binding_id = ?")
        .get("binding:telegram:dm::chat-1:codex:thread-1"),
    ).toEqual({ count: 1 });
    expect(
      stateDb.raw
        .prepare(
          `SELECT conversation_title, actor_display_name, summary
           FROM messaging_activity_log
           WHERE kind = ?
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get("inbound-routed"),
    ).toEqual({
      conversation_title: adversarialText,
      actor_display_name: adversarialText,
      summary: `Inbound from ${adversarialText}`,
    });
  });

  it("does not reload config after the startup policy snapshot", async () => {
    await prepareRuntimeStore();
    const adapter = createAdapter("telegram");
    const configLoader = vi.fn(() => ({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram" as const,
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    }));
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: configLoader,
    });

    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    await bridge.emitBackendEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "command-1",
            type: "commandExecution",
            command: "pnpm test",
            status: "completed",
          },
        },
      },
    });

    expect(configLoader).toHaveBeenNthCalledWith(1, {
      logStartupEligibility: true,
    });
    expect(configLoader).toHaveBeenCalledTimes(1);
  });

  it("uses adapter-supplied authorization without provider-specific runtime config", async () => {
    await prepareRuntimeStore();
    const adapter = createAdapter("custom", {
      authorizedActorIds: ["driver-1"],
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {},
    });

    await runtime.start();
    await adapter.listener?.({
      ...buildCommandEvent("/resume"),
      actor: {
        platformUserId: "driver-1",
      },
      channel: {
        channel: "custom",
        conversation: {
          id: "chat-1",
          kind: "dm",
        },
      },
    });

    expect(messagingLog.warn).not.toHaveBeenCalled();
    expect(bridge.getNavigationQueryPage).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 2, consumer: "messaging-browse", pageSize: 8,
      query: expect.objectContaining({ kind: "messaging-threads" }),
    }));
    expect(bridge.getNavigationSnapshot).not.toHaveBeenCalled();
  });

  async function startMentionOnlyRuntime(options: {
    automationInboundHandler: MessagingAutomationInboundHandler;
    automationInboundMatches: MessagingAutomationInboundMatcher;
    reportsBotMention?: boolean;
  }): Promise<{
    adapter: ReturnType<typeof createAdapter>;
    bridge: ReturnType<typeof createBackendBridge>;
    configLoader: ReturnType<typeof vi.fn>;
  }> {
    await prepareRuntimeStore();
    const { resetInboundPreview } = await import(
      "../messaging/inbound-preview-bus"
    );
    resetInboundPreview();
    const adapter = createAdapter(
      "telegram",
      options.reportsBotMention === false
        ? {
            capabilityProfile: {
              ...PERMISSIVE_CAPABILITY_PROFILE,
              conversationInput: {
                reportsBotMention: false,
              },
            },
          }
        : {},
    );
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const configLoader = vi.fn(() => ({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram" as const,
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
        responseMode: "mention_only" as const,
      },
    }));
    const runtime = trackRuntime(
      new Runtime({
        adapterFactory: () => [adapter],
        backendBridge: bridge,
        automationInboundHandler: options.automationInboundHandler,
        automationInboundMatches: options.automationInboundMatches,
        config: configLoader,
      }),
    );
    await runtime.start();
    return { adapter, bridge, configLoader };
  }

  const ambientEvent = {
    id: "ambient-1",
    kind: "text" as const,
    actor: { platformUserId: "user-1" },
    channel: {
      channel: "telegram" as const,
      conversation: { id: "chat-ambient", kind: "channel" as const },
    },
    receivedAt: 1000,
    text: "ERROR something happened",
  };

  it("keeps an unregistered connection out of singleton admission, including automation-only traffic", async () => {
    const automationInboundHandler = vi.fn(async () => true);
    const automationInboundMatches = vi.fn(() => true);
    const { adapter, bridge } = await startMentionOnlyRuntime({
      automationInboundHandler,
      automationInboundMatches,
    });
    for (const observedOnly of [false, true]) {
      await adapter.listener?.({
        ...ambientEvent,
        observedOnly,
        channel: { ...ambientEvent.channel, connectionId: "unknown-connection" },
      });
    }
    expect(automationInboundMatches).not.toHaveBeenCalled();
    expect(automationInboundHandler).not.toHaveBeenCalled();
    expect(bridge.startTurn).not.toHaveBeenCalled();
    expect(adapter.delivered).toEqual([]);

    await adapter.listener?.(ambientEvent);
    expect(automationInboundHandler).toHaveBeenCalledOnce();
  });

  it("admits only the singleton provider event to the restart reply path", async () => {
    const { holdUpdateBlockingWork } = await import("../app-update-admission");
    const { MessagingController } = await import("../messaging/core/messaging-controller");
    const reportRestart = vi.spyOn(MessagingController.prototype, "reportUpdateRestarting");
    const { adapter } = await startMentionOnlyRuntime({
      automationInboundHandler: vi.fn(async () => false),
      automationInboundMatches: vi.fn(() => false),
    });
    const release = holdUpdateBlockingWork();
    try {
      expect(release).toBeDefined();
      for (const channel of [
        { ...ambientEvent.channel, connectionId: "unknown-connection" },
        { ...ambientEvent.channel, channel: "slack" as const },
        ambientEvent.channel,
      ]) {
        await adapter.listener?.({ ...ambientEvent, channel });
      }
      expect(reportRestart).toHaveBeenCalledExactlyOnceWith(ambientEvent);
    } finally {
      release?.();
      reportRestart.mockRestore();
    }
  });

  it("delivers @mention-only messages an automation filter matches", async () => {
    const automationInboundHandler = vi.fn(async () => false);
    // The automation's own filter matches this ambient (non-@mention) message,
    // so it must be delivered even though the channel is @mention-only.
    const automationInboundMatches = vi.fn(() => true);
    const { adapter } = await startMentionOnlyRuntime({
      automationInboundHandler,
      automationInboundMatches,
    });

    await adapter.listener?.(ambientEvent);

    expect(automationInboundHandler).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "text", text: "ERROR something happened" }),
    );
    // @mention-only mode still suppresses a normal agent reply.
    expect(
      adapter.delivered.some((intent) => intent.kind === "message"),
    ).toBe(false);
  });

  it("records an automation-matched observed-only sender as routed", async () => {
    await prepareRuntimeStore();
    const automationInboundHandler = vi.fn(async () => true);
    const automationInboundMatches = vi.fn(() => true);
    const adapter = createAdapter("slack", {
      authorizedActorIds: ["operator-1"],
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      automationInboundHandler,
      automationInboundMatches,
      config: {},
    }));
    await runtime.start();

    await adapter.listener?.({
      id: "slack:message:datadog-1",
      kind: "text",
      actor: {
        platformUserId: "B012DATADOG",
        displayName: "Datadog",
        isBot: true,
      },
      channel: {
        channel: "slack",
        conversation: {
          id: "C012SEARCHBOTS",
          kind: "channel",
          title: "t-search-bots",
        },
      },
      observedOnly: true,
      receivedAt: 1_000,
      text: "Search pipeline alert",
    });

    expect(automationInboundMatches).toHaveBeenCalledTimes(1);
    expect(automationInboundHandler).toHaveBeenCalledTimes(1);
    expect(bridge.startTurn).not.toHaveBeenCalled();

    const { getAppStateDb } = await import("../state/app-state");
    const rows = getAppStateDb().raw
      .prepare(
        `SELECT kind, actor_id, conversation_id
         FROM messaging_activity_log
         WHERE actor_id = ?
         ORDER BY id ASC`,
      )
      .all("B012DATADOG") as Array<{
        actor_id: string;
        conversation_id: string;
        kind: string;
      }>;
    expect(rows).toEqual([{
      actor_id: "B012DATADOG",
      conversation_id: "C012SEARCHBOTS",
      kind: "inbound-routed",
    }]);
  });

  it("observes a conversation while an editor preview watches it", async () => {
    // Otherwise the preview shows only senders on the actor allowlist, and an
    // operator previewing an alert channel before saving sees nothing.
    await prepareRuntimeStore();
    const updateObservedConversations = vi.fn();
    const adapter = createAdapter("discord", { updateObservedConversations });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const { startInboundPreview, stopInboundPreview } = await import(
      "../messaging/inbound-preview-bus"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: createBackendBridge(),
      config: {},
    }));
    await runtime.start();
    updateObservedConversations.mockClear();

    startInboundPreview("preview-alerts", {
      provider: "discord",
      conversationId: "1480556454498009352",
    });
    expect(updateObservedConversations).toHaveBeenLastCalledWith([
      "1480556454498009352",
    ]);
    // Another platform's preview is not this adapter's business.
    startInboundPreview("preview-slack", { provider: "slack", conversationId: "C1" });
    expect(updateObservedConversations).toHaveBeenLastCalledWith([
      "1480556454498009352",
    ]);

    stopInboundPreview("preview-alerts");
    stopInboundPreview("preview-slack");
    expect(updateObservedConversations).toHaveBeenLastCalledWith([]);
  });

  it("keeps unmatched observed-only senders rejected", async () => {
    await prepareRuntimeStore();
    const automationInboundHandler = vi.fn(async () => true);
    const adapter = createAdapter("slack", {
      authorizedActorIds: ["operator-1"],
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      automationInboundHandler,
      automationInboundMatches: () => false,
      config: {},
    }));
    await runtime.start();

    await adapter.listener?.({
      id: "slack:message:other-bot-1",
      kind: "text",
      actor: {
        platformUserId: "B012OTHERBOT",
        displayName: "Other Bot",
        isBot: true,
      },
      channel: {
        channel: "slack",
        conversation: {
          id: "C012SEARCHBOTS",
          kind: "channel",
          title: "t-search-bots",
        },
      },
      observedOnly: true,
      receivedAt: 1_000,
      text: "Unrelated message",
    });

    expect(automationInboundHandler).not.toHaveBeenCalled();
    expect(bridge.startTurn).not.toHaveBeenCalled();

    const { getAppStateDb } = await import("../state/app-state");
    const row = getAppStateDb().raw
      .prepare(
        `SELECT kind
         FROM messaging_activity_log
         WHERE actor_id = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get("B012OTHERBOT") as { kind: string } | undefined;
    expect(row?.kind).toBe("inbound-rejected");
  });

  it("drops ambient @mention-only messages no automation filter matches", async () => {
    const automationInboundHandler = vi.fn(async () => false);
    const automationInboundMatches = vi.fn(() => false);
    const { adapter, configLoader } = await startMentionOnlyRuntime({
      automationInboundHandler,
      automationInboundMatches,
    });

    await adapter.listener?.(ambientEvent);

    // No automation matches and no preview is active: the message is dropped
    // before the controller, preserving @mention-only behavior for normal chat.
    expect(automationInboundHandler).not.toHaveBeenCalled();
    expect(
      adapter.delivered.some((intent) => intent.kind === "message"),
    ).toBe(false);
    expect(configLoader).toHaveBeenCalledTimes(1);
  });

  it("applies channel response mode to strict bindings unless the binding overrides it", async () => {
    const automationInboundHandler = vi.fn(async () => false);
    const automationInboundMatches = vi.fn(() => false);
    const { adapter, bridge } = await startMentionOnlyRuntime({
      automationInboundHandler,
      automationInboundMatches,
    });
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    const store = getDesktopMessagingStore();
    const binding = {
      id: "binding:telegram:channel::chat-ambient:codex:thread-1",
      authorizedActorIds: ["user-1"],
      backend: "codex" as const,
      channel: ambientEvent.channel,
      createdAt: 1000,
      targetKind: "thread" as const,
      threadId: "thread-1",
      updatedAt: 1000,
    };
    await store.upsertBinding(binding);

    await adapter.listener?.(ambientEvent);

    expect(bridge.startTurn).not.toHaveBeenCalled();

    await adapter.listener?.({
      ...buildCallbackEvent("status:response-mode", {}),
      id: "ambient-response-mode-picker",
      channel: ambientEvent.channel,
    });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "single_select",
      prompt: expect.stringContaining("Responses"),
    });

    await adapter.listener?.({
      ...ambientEvent,
      id: "ambient-response-mode-choice",
      text: "3",
    });
    await expect(
      store.findActiveBindingForChannel(ambientEvent.channel),
    ).resolves.toMatchObject({
      preferences: {
        responseMode: "every_message",
      },
    });
    expect(bridge.startTurn).not.toHaveBeenCalled();

    await adapter.listener?.({
      ...ambientEvent,
      id: "ambient-2",
      text: "continue without a mention",
    });
    await waitFor(() => vi.mocked(bridge.startTurn).mock.calls.length > 0);

    expect(bridge.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "continue without a mention" }],
      }),
    );
  });

  it("routes an accepted shared reply without reloading runtime settings", async () => {
    await prepareRuntimeStore();
    const adapter = createAdapter("telegram");
    const bridge = createBackendBridge();
    const config: DesktopMessagingConfig = {
      inputDebounceMs: 60_000,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
        responseMode: "mention_only",
      },
    };
    const deferredReload = createDeferred<DesktopMessagingConfig>();
    const reloadStarted = createDeferred<void>();
    const loadConfig = vi.fn()
      .mockResolvedValueOnce(config)
      .mockImplementation(async () => {
        reloadStarted.resolve();
        return await deferredReload.promise;
      });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: loadConfig,
    }));
    await runtime.start();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:telegram:channel::chat-1:codex:thread-1",
      authorizedActorIds: ["user-1"],
      backend: "codex",
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "channel",
        },
      },
      createdAt: 1_000,
      targetKind: "thread",
      threadId: "thread-1",
      updatedAt: 1_000,
    });

    const handled = adapter.listener?.({
      ...buildTextEvent("continue in the channel"),
      botMention: true,
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "channel",
        },
      },
    });
    const outcome = await Promise.race([
      handled?.then(() => "handled" as const),
      reloadStarted.promise.then(() => "config-reload" as const),
    ]);
    deferredReload.resolve(config);
    await handled;

    expect(outcome).toBe("handled");
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(bridge.startTurn).not.toHaveBeenCalled();
    expect(messagingLog.debug).toHaveBeenCalledWith(
      "messaging admission append timing",
      expect.objectContaining({
        eventId: "event-text",
        finalAdmissionAppendAwaitMs: expect.any(Number),
        platform: "telegram",
      }),
    );
  });

  it("hot-replaces the response-mode snapshot without restarting the adapter", async () => {
    await prepareRuntimeStore();
    const updateAuthorization = vi.fn(async () => undefined);
    const adapter = createAdapter("telegram", { updateAuthorization });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
          responseMode: "every_message",
        },
      },
    }));
    await runtime.start();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:telegram:channel::chat-1:codex:thread-1",
      authorizedActorIds: ["user-1"],
      backend: "codex",
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "channel",
        },
      },
      createdAt: 1_000,
      targetKind: "thread",
      threadId: "thread-1",
      updatedAt: 1_000,
    });

    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
        responseMode: "mention_only",
      },
    });
    await adapter.listener?.({
      ...buildTextEvent("ambient after hot apply"),
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "channel",
        },
      },
    });

    expect(updateAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ responseMode: "mention_only" }),
    );
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(bridge.startTurn).not.toHaveBeenCalled();
  });

  it("dispatches ambient replies in a native thread inside a 1:1 DM", async () => {
    const { adapter, bridge } = await startMentionOnlyRuntime({
      automationInboundHandler: vi.fn(async () => false),
      automationInboundMatches: vi.fn(() => false),
    });
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    const channel = {
      channel: "telegram" as const,
      conversation: {
        id: "dm-1",
        isDirectMessage: true,
        kind: "thread" as const,
        parentConversationId: "dm-1",
        parentId: "private-response-1",
      },
    };
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:telegram:thread:private-response-1:dm-1:codex:thread-1",
      authorizedActorIds: ["user-1"],
      backend: "codex",
      channel,
      createdAt: 1000,
      targetKind: "agent_thread",
      threadId: "thread-1",
      updatedAt: 1000,
    });

    await adapter.listener?.({
      ...ambientEvent,
      channel,
      id: "dm-thread-reply",
      text: "continue without a mention",
    });
    await waitFor(() => vi.mocked(bridge.startTurn).mock.calls.length > 0);

    expect(bridge.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        input: [{ type: "text", text: "continue without a mention" }],
      }),
    );
  });

  it("does not enforce response modes without bot-mention reporting", async () => {
    const { adapter, bridge } = await startMentionOnlyRuntime({
      automationInboundHandler: vi.fn(async () => false),
      automationInboundMatches: vi.fn(() => false),
      reportsBotMention: false,
    });
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:telegram:channel::chat-ambient:codex:thread-1",
      authorizedActorIds: ["user-1"],
      backend: "codex",
      channel: ambientEvent.channel,
      createdAt: 1000,
      preferences: {
        responseMode: "mention_only",
        updatedAt: 1000,
      },
      targetKind: "thread",
      threadId: "thread-1",
      updatedAt: 1000,
    });

    await adapter.listener?.(ambientEvent);
    await waitFor(() => vi.mocked(bridge.startTurn).mock.calls.length > 0);

    expect(bridge.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        input: [{ type: "text", text: ambientEvent.text }],
      }),
    );
  });

  it("logs inbound controller failures without rejecting the adapter listener", async () => {
    const { runtime, adapter, bridge } = await createRuntimeHarness();
    vi.mocked(bridge.getNavigationLaunchpadConfig!).mockRejectedValueOnce(
      new Error("navigation failed"),
    );

    await runtime.start();
    await expect(adapter.listener?.(buildCommandEvent("/resume"))).resolves
      .toBeUndefined();

    expect(messagingLog.error).toHaveBeenCalledWith(
      "messaging controller failed to handle inbound event",
      expect.objectContaining({
        channel: "telegram",
        conversationId: "chat-1",
        error: expect.any(Error),
        eventId: "event-command",
        eventKind: "command",
      }),
    );
  });

  it("forwards backend turn completions to bound channel adapters", async () => {
    const { runtime, adapter, emitBackendEvent } = await createRuntimeHarness();

    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );

    await emitBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [
              {
                type: "text",
                text: "Done",
              },
            ],
          },
        },
      },
    });
    await Promise.resolve();

    expect([...adapter.delivered].reverse().find((intent) => intent.kind === "message"))
      .toMatchObject({
        kind: "message",
        role: "assistant",
      });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
  });

  it("routes backend approval requests to bound channel adapters", async () => {
    const { runtime, adapter, emitBackendEvent } = await createRuntimeHarness();

    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    adapter.delivered.length = 0;

    await emitBackendEvent({
      backend: "codex",
      notification: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "approval-1",
          prompt: "Run tests?",
          command: "pnpm test -- messaging-runtime",
        },
      },
    });

    expect(adapter.delivered.find((intent) => intent.kind === "approval"))
      .toMatchObject({
        kind: "approval",
        requestContext: {
          backend: "codex",
          requestId: "approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "status",
      status: "waiting",
    });

    const { getDesktopMessagingActivityLog } = await import(
      "../messaging/desktop-messaging-activity-log"
    );
    expect(getDesktopMessagingActivityLog().getPlatformActivitySummary()).toEqual({
      summaries: [
        expect.objectContaining({
          platform: "telegram",
          lastResponseAt: 1000,
        }),
      ],
    });

    const { getAppStateDb } = await import("../state/app-state");
    const outboundRowCount = getAppStateDb().raw
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messaging_activity_log
         WHERE kind = ?`,
      )
      .get("outbound") as { count: number };
    expect(outboundRowCount.count).toBe(0);
  });

  it("does not route backend requests to adapters for bindings owned by another channel", async () => {
    await prepareRuntimeStore();
    const telegramAdapter = createAdapter("telegram");
    const discordAdapter = createAdapter("discord");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const bridge = createBackendBridge();
    const runtime = new Runtime({
      adapterFactory: () => [telegramAdapter, discordAdapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await telegramAdapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    telegramAdapter.delivered.length = 0;
    discordAdapter.delivered.length = 0;

    await bridge.emitBackendEvent({
      backend: "codex",
      notification: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "approval-1",
          prompt: "Run tests?",
          command: "pnpm test -- messaging-runtime",
        },
      },
    });

    expect(telegramAdapter.delivered.find((intent) => intent.kind === "approval"))
      .toMatchObject({
        kind: "approval",
      });
    expect(discordAdapter.delivered).toEqual([]);
  });

  it("resolves an ephemeral Agent origin after multiple unrelated providers", async () => {
    await prepareRuntimeStore();
    const lineAdapter = createAdapter("line");
    const mattermostAdapter = createAdapter("mattermost");
    const telegramAdapter = createAdapter("telegram");
    const bridge = createBackendBridge();
    const navigation = buildNavigationSnapshot();
    navigation.threads[0] = {
      ...navigation.threads[0]!,
      agent: {
        name: "Jeeves",
        instructionLineCount: 1,
        instructionsTooLong: false,
        updatedAt: 1000,
      },
    };
    navigation.threads.push({
      id: "thread-2",
      title: "Whimsical breakfast questionnaire",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: {
        inInbox: false,
      },
    });
    bridge.readNavigationFixturePopulation = vi.fn(async () => navigation);
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    const store = getDesktopMessagingStore();
    await store.upsertDefaultAgentAssignment({
      id: "default-agent:telegram-provider",
      scope: {
        kind: "provider",
        channel: "telegram",
      },
      target: {
        kind: "agent",
        backend: "codex",
        threadId: "thread-1",
      },
      createdAt: 1000,
      updatedAt: 1000,
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [lineAdapter, mattermostAdapter, telegramAdapter],
      backendBridge: bridge,
      config: {
        inputDebounceMs: 0,
        line: {
          channel: "line",
          channelSecret: "line-secret",
          callbackBaseUrl: "http://127.0.0.1:47822/",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        mattermost: {
          channel: "mattermost",
          botToken: "mattermost-token",
          callbackBaseUrl: "http://127.0.0.1:47821/",
          serverUrl: "https://mattermost.example.com",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }));

    await runtime.start();
    await telegramAdapter.listener?.(buildTextEvent("Attach a fun thread here."));

    const response = await runtime.handlePwrAgentMessagingRequest({
      operation: "attach_thread_here",
      context: {
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      args: {
        backend: "codex",
        threadId: "thread-2",
        placement: "auto",
        targetKind: "thread",
      },
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        outcome: "attached",
        placement: "current_conversation",
      },
    });
    await expect(store.findActiveBindingForChannel({
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    })).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-2",
    });
  });

  it.each(["list_messaging_surfaces", "attach_thread_to_surface"] as const)("routes %s past Telegram to the owning Slack controller and preserves its denials", async (operation) => {
    await prepareRuntimeStore();
    let authorized = true;
    const telegramAuthorization = vi.fn(() => true);
    const telegramAdapter = createAdapter("telegram", {
      retainedSourceConnectionId: () => "telegram-fixture",
      authorizeRetainedSource: telegramAuthorization,
    });
    const createManagedConversation = vi.fn(async () => ({
      channel: "slack" as const, outcome: "created" as const, updatedAt: 2000,
      conversation: { id: "C4", kind: "thread" as const, parentId: "1000.000004", parentConversationId: "C4", workspaceId: "T1" },
    }));
    const slackAdapter = createAdapter("slack", {
      retainedSourceConnectionId: () => "slack-fixture",
      authorizeRetainedSource: () => authorized,
      createManagedConversation,
    });
    const bridge = createBackendBridge();
    const navigation = buildNavigationSnapshot();
    navigation.threads.push({ ...navigation.threads[0]!, id: "thread-2", title: "Builder" });
    navigation.threads[0]!.agent = { name: "Manager", instructionLineCount: 1, instructionsTooLong: false, updatedAt: 1000 };
    bridge.readNavigationFixturePopulation = vi.fn(async () => navigation);
    const event = { ...buildTextEvent("Attach the builder."), botMention: true,
      channel: { channel: "slack" as const, conversation: { id: "C4", kind: "channel" as const, workspaceId: "T1" } } };
    const { getDesktopMessagingStore } = await import("../messaging/desktop-messaging-store");
    await getDesktopMessagingStore().upsertBinding({ id: "slack-manager", backend: "codex", threadId: "thread-1",
      targetKind: "agent_thread", channel: event.channel, authorizedActorIds: ["user-1"], createdAt: 1000, updatedAt: 1000 });
    const { DesktopMessagingRuntime: Runtime } = await import("../messaging/messaging-runtime");
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [telegramAdapter, slackAdapter], backendBridge: bridge,
      config: {
        inputDebounceMs: 0,
        telegram: { channel: "telegram", botToken: "telegram-token", authorizedActorIds: [{ id: "user-1", displayName: "" }] },
        slack: { channel: "slack", appToken: "slack-app-token", botToken: "slack-bot-token", signingSecret: "slack-signing-secret",
          authorizedActorIds: [{ id: "user-1", displayName: "" }] },
      },
    }));
    await runtime.start();
    await slackAdapter.listener!(event);
    expect(bridge.startTurn).toHaveBeenCalledTimes(1);
    const source = vi.mocked(bridge.startTurn).mock.calls[0]?.[0].messageOrigin?.causalMessagingSource;
    expect(source).toBeDefined();
    const args = { backend: "codex" as const, threadId: "thread-2", placement: "new_child" as const };
    const context = { backend: "codex" as const, threadId: "thread-1", turnId: "completion", causalMessagingSource: source };
    expect(await runtime.handlePwrAgentMessagingRequest({ operation, context, args })).toMatchObject({ ok: true });
    // A live-origin fallback has no source in Telegram's controller either.
    expect(await runtime.handlePwrAgentMessagingRequest({ operation, args,
      context: { ...context, turnId: "turn-1", causalMessagingSource: undefined } })).toMatchObject({ ok: true });
    authorized = false;
    expect(await runtime.handlePwrAgentMessagingRequest({ operation, context, args }))
      .toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(telegramAuthorization).not.toHaveBeenCalled();
    expect(createManagedConversation).toHaveBeenCalledTimes(operation === "attach_thread_to_surface" ? 1 : 0);
  });

  it.each([false, true])("original-file authority follows the owner independently of adapter order (Slack first: %s)", async (slackFirst) => {
    await prepareRuntimeStore();
    let authorized = true;
    const data = Buffer.from([0, 255, 42, 7]);
    const telegramAuthorization = vi.fn(() => true);
    const telegram = createAdapter("telegram", {
      retainedSourceConnectionId: () => "telegram-fixture",
      authorizeRetainedSource: telegramAuthorization,
    });
    const slack = createAdapter("slack", {
      retainedSourceConnectionId: () => "slack-fixture",
      authorizeRetainedSource: () => authorized,
      downloadAttachment: async ({ attachment }) => ({ data, fileName: attachment.name,
        mimeType: "application/zip", sizeBytes: data.length }),
    });
    const bridge = createBackendBridge();
    const navigation = buildNavigationSnapshot();
    navigation.threads[0]!.agent = { name: "Manager", instructionLineCount: 1, instructionsTooLong: false, updatedAt: 1000 };
    bridge.readNavigationFixturePopulation = vi.fn(async () => navigation);
    const event = { ...buildTextEvent("Save the original"), kind: "media" as const, text: "Save the original",
      botMention: true, receivedAt: Date.now(), disposition: "available" as const,
      channel: { channel: "slack" as const, conversation: { id: "C4", kind: "channel" as const, workspaceId: "T1" } },
      attachments: [{ id: "private-provider-id", name: "archive.zip", kind: "file" as const,
        mimeType: "application/zip", disposition: "available" as const }] };
    const { getDesktopMessagingStore } = await import("../messaging/desktop-messaging-store");
    await getDesktopMessagingStore().upsertBinding({ id: "slack-originals", backend: "codex", threadId: "thread-1",
      targetKind: "agent_thread", channel: event.channel, authorizedActorIds: ["user-1"], createdAt: 1000, updatedAt: 1000 });
    const { DesktopMessagingRuntime: Runtime } = await import("../messaging/messaging-runtime");
    const runtime = trackRuntime(new Runtime({ adapterFactory: () => slackFirst ? [slack, telegram] : [telegram, slack], backendBridge: bridge,
      config: { inputDebounceMs: 0,
        telegram: { channel: "telegram", botToken: "synthetic-token", authorizedActorIds: [{ id: "user-1", displayName: "" }] },
        slack: { channel: "slack", appToken: "synthetic-app", botToken: "synthetic-bot", signingSecret: "synthetic-secret",
          authorizedActorIds: [{ id: "user-1", displayName: "" }] } } }));
    await runtime.start();
    await slack.listener!(event);
    expect(bridge.startTurn).toHaveBeenCalledTimes(1);
    const source = vi.mocked(bridge.startTurn).mock.calls[0]![0].messageOrigin?.causalMessagingSource;
    expect(source).toBeDefined();
    // Finite owner oracle: both adapter permutations must return the same
    // original for live fallback, retained provenance, and restarted history.
    const live = { backend: "codex" as const, threadId: "thread-1", turnId: "turn-1", messagingTurn: true };
    const retained = { ...live, turnId: "completion", causalMessagingSource: source };
    for (const context of [live, retained]) {
      const listed = await runtime.handlePwrAgentMessagingRequest({ operation: "list_messaging_attachments", context, args: {} });
      expect(listed).toMatchObject({ ok: true, data: { attachments: [{ name: "archive.zip" }] } });
    }
    await runtime.stop();
    await runtime.start();
    const listed = await runtime.handlePwrAgentMessagingRequest({ operation: "list_messaging_attachments", context: retained, args: {} });
    expect(listed).toMatchObject({ ok: true, data: { attachments: [{ name: "archive.zip" }] } });
    if (!listed.ok || !("attachments" in listed.data)) throw new Error("Expected original metadata");
    const args = { attachmentId: listed.data.attachments[0]!.attachmentId };
    const exported = await runtime.handlePwrAgentMessagingRequest({ operation: "export_messaging_attachment", context: retained, args });
    if (!exported.ok || !("path" in exported.data)) throw new Error("Expected original export");
    expect(await readFile(exported.data.path)).toEqual(data);
    authorized = false;
    for (const request of [
      { operation: "list_messaging_attachments", context: retained, args: {} },
      { operation: "export_messaging_attachment", context: retained, args },
    ] as const) {
      expect(await runtime.handlePwrAgentMessagingRequest(request))
        .toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(telegramAuthorization).not.toHaveBeenCalled();
  });

  it("clears resolved approval buttons through the owning channel adapter only", async () => {
    await prepareRuntimeStore();
    const telegramAdapter = createAdapter("telegram");
    const discordAdapter = createAdapter("discord");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const bridge = createBackendBridge();
    const runtime = new Runtime({
      adapterFactory: () => [telegramAdapter, discordAdapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await telegramAdapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );

    await bridge.emitBackendEvent({
      backend: "codex",
      notification: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "approval-1",
          prompt: "Run tests?",
          command: "pnpm test -- messaging-runtime",
        },
      },
    });
    telegramAdapter.delivered.length = 0;
    discordAdapter.delivered.length = 0;

    await bridge.emitBackendEvent({
      backend: "codex",
      notification: {
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          requestId: "approval-1",
        },
      },
    });

    expect(
      telegramAdapter.delivered.find(
        (intent) => intent.kind === "approval" && intent.decisions.length === 0,
      ),
    ).toMatchObject({
      kind: "approval",
      decisions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
    });
    expect(discordAdapter.delivered).toEqual([]);
  });

  it("routes backend user-input requests to bound channel adapters", async () => {
    const { runtime, adapter, emitBackendEvent } = await createRuntimeHarness();

    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    adapter.delivered.length = 0;

    await emitBackendEvent({
      backend: "codex",
      notification: {
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "input-1",
          questions: [
            {
              id: "q1",
              header: "Mode",
              question: "How should I proceed?",
              isOther: true,
              isSecret: false,
              options: [
                {
                  label: "Implement",
                  description: "Start coding.",
                },
              ],
            },
          ],
        },
      },
    });

    expect(adapter.delivered.find((intent) => intent.kind === "questionnaire"))
      .toMatchObject({
        kind: "questionnaire",
        requestContext: {
          backend: "codex",
          requestId: "input-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "status",
      status: "waiting",
    });
  });

  it("routes MCP login requests to bound channel adapters", async () => {
    const { runtime, adapter, emitBackendEvent } = await createRuntimeHarness();

    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    adapter.delivered.length = 0;

    await emitBackendEvent({
      backend: "codex",
      notification: {
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "mcp-login-1",
          serverName: "github",
          mode: "url",
          _meta: null,
          message: "Reconnect GitHub to restore access.",
          url: "https://example.test/oauth/start?state=opaque",
          elicitationId: "elicitation-1",
        },
      },
    });

    expect(adapter.delivered.find((intent) => intent.kind === "approval"))
      .toMatchObject({
        kind: "approval",
        title: "MCP Link",
        body: expect.stringContaining("github asks to open a page on `example.test`."),
        requestContext: {
          backend: "codex",
          method: "mcpServer/elicitation/request",
          requestId: "mcp-login-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
  });

  it("logs rejected inbound actor ids before returning the authorization error", async () => {
    const { runtime, adapter } = await createRuntimeHarness();

    await runtime.start();
    const event = buildCommandEvent("/resume");
    event.actor = {
      displayName: "Other User",
      platformUserId: "user-2",
      username: "other",
    };
    await adapter.listener?.(event);

    expect(messagingLog.warn).toHaveBeenCalledWith(
      "messaging event rejected by authorization",
      expect.objectContaining({
        actorDisplayName: "Other User",
        actorId: "user-2",
        actorUsername: "other",
        authorizedActorCount: 1,
        channel: "telegram",
        conversationId: "chat-1",
        conversationKind: "dm",
        eventId: "event-command",
        eventKind: "command",
      }),
    );
    expect(adapter.delivered.at(-1)).toMatchObject({
      body: "This channel user is not authorized to control PwrAgent.",
      kind: "error",
      title: "Not authorized",
    });
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await expect(getDesktopMessagingStore().findObservedSurfaces()).resolves
      .toEqual([
        expect.objectContaining({
          channel: expect.objectContaining({
            channel: "telegram",
            conversation: expect.objectContaining({ id: "chat-1" }),
          }),
        }),
      ]);
  });

  it("keeps other adapters available when one adapter fails during startup", async () => {
    await prepareRuntimeStore();
    const failingAdapter = createAdapter("telegram", {
      start: vi.fn(async () => {
        throw new Error("telegram unavailable");
      }),
    });
    const workingAdapter = createAdapter("discord");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const bridge = createBackendBridge();
    const runtime = new Runtime({
      adapterFactory: () => [failingAdapter, workingAdapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();

    expect(workingAdapter.start).toHaveBeenCalledTimes(1);
    expect(messagingLog.error).toHaveBeenCalledWith(
      "telegram: failed to start adapter",
      expect.objectContaining({
        channel: "telegram",
      }),
    );
    expect(messagingLog.info).toHaveBeenCalledWith(
      "messaging runtime config applied",
      expect.objectContaining({
        started: ["discord"],
        failed: ["telegram"],
      }),
    );
  });

  it("times out a stuck adapter start and reports an error without blocking other adapters", async () => {
    await prepareRuntimeStore();
    const stuckStart = createDeferred<void>();
    const stuckAdapter = createAdapter("discord", {
      start: vi.fn(async () => {
        await stuckStart.promise;
      }),
    });
    const workingAdapter = createAdapter("telegram");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [stuckAdapter, workingAdapter],
      adapterStartTimeoutMs: 1,
      backendBridge: createBackendBridge(),
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }));

    await runtime.start();

    expect(stuckAdapter.stop).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "discord",
          health: "errored",
          reason: "discord adapter startup did not complete within 1 ms.",
        }),
        expect.objectContaining({
          platform: "telegram",
          health: "enabled",
        }),
      ]),
    );
    expect(messagingLog.info).toHaveBeenCalledWith(
      "messaging runtime config applied",
      expect.objectContaining({
        started: ["telegram"],
        failed: ["discord"],
      }),
    );
  });

  it("starts adapters in parallel and reports pending adapters as loading", async () => {
    await prepareRuntimeStore();
    const telegramStart = createDeferred<void>();
    const telegramStarting = createDeferred<void>();
    const discordStarting = createDeferred<void>();
    const slowTelegramAdapter = createAdapter("telegram");
    slowTelegramAdapter.start.mockImplementation(async (listener) => {
      slowTelegramAdapter.listener = listener;
      telegramStarting.resolve();
      await telegramStart.promise;
    });
    const workingDiscordAdapter = createAdapter("discord");
    workingDiscordAdapter.start.mockImplementation(async (listener) => {
      workingDiscordAdapter.listener = listener;
      discordStarting.resolve();
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [slowTelegramAdapter, workingDiscordAdapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });
    const events: unknown[] = [];
    runtime.onPlatformStatus((event) => events.push(event));

    const startPromise = runtime.start();
    // Loading the controller is asynchronous. Observe both real start calls
    // while Telegram remains blocked, so serial adapter startup still fails.
    await Promise.all([telegramStarting.promise, discordStarting.promise]);

    expect(slowTelegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(workingDiscordAdapter.start).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "health-changed",
        platform: "telegram",
        health: "unknown",
      }),
    );
    await waitFor(() => runtime.getPlatformStatuses().some(
      (status) => status.platform === "discord" && status.health === "enabled",
    ));
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "telegram",
          health: "unknown",
        }),
        expect.objectContaining({
          platform: "discord",
          health: "enabled",
        }),
      ]),
    );
    await workingDiscordAdapter.listener?.(
      buildCallbackEvent(
        "bind:codex:thread-1",
        {
          backend: "codex",
          threadId: "thread-1",
        },
        "discord",
      ),
    );
    workingDiscordAdapter.delivered.length = 0;
    await bridge.emitBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [{ type: "text", text: "Discord is already online" }],
          },
        },
      },
    });

    expect(
      workingDiscordAdapter.delivered.find((intent) => intent.kind === "message"),
    ).toMatchObject({ kind: "message" });

    telegramStart.resolve();
    await startPromise;

    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "telegram",
          health: "enabled",
        }),
      ]),
    );
  });

  it("skips adapter startup when a stop request arrives before adapters register", async () => {
    await prepareRuntimeStore();
    const slowTelegramAdapter = createAdapter("telegram");
    const workingDiscordAdapter = createAdapter("discord");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [slowTelegramAdapter, workingDiscordAdapter],
      backendBridge: createBackendBridge(),
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    const startPromise = runtime.start();
    const stopPromise = runtime.stop();
    await Promise.all([startPromise, stopPromise]);

    expect(slowTelegramAdapter.start).not.toHaveBeenCalled();
    expect(workingDiscordAdapter.start).not.toHaveBeenCalled();
    expect(slowTelegramAdapter.stop).not.toHaveBeenCalled();
    expect(workingDiscordAdapter.stop).not.toHaveBeenCalled();
    expect(runtime.isEnabled()).toBe(false);
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "telegram",
          health: "suspended",
        }),
        expect.objectContaining({
          platform: "discord",
          health: "suspended",
        }),
      ]),
    );
  });

  it("cleans up again when a cancelled adapter start rejects late", async () => {
    await prepareRuntimeStore();
    const discordStart = createDeferred<void>();
    const discordAdapter = createAdapter("discord", {
      start: vi.fn(async () => {
        await discordStart.promise;
      }),
    });
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) =>
      config.discord ? [discordAdapter] : []
    );
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }));

    const startPromise = runtime.start();
    await waitFor(() => discordAdapter.start.mock.calls.length === 1);
    const applyPromise = runtime.applyConfig({});
    await Promise.all([startPromise, applyPromise]);

    expect(discordAdapter.stop).toHaveBeenCalledTimes(1);
    discordStart.reject(new Error("login rejected after cancellation"));
    await waitFor(() => discordAdapter.stop.mock.calls.length === 2);
    expect(messagingLog.info).toHaveBeenCalledWith(
      "discord: stopped adapter after late startup",
      { channel: "discord" },
    );
  });

  it("cancels a pending adapter start when that platform is disabled", async () => {
    await prepareRuntimeStore();
    const discordStart = createDeferred<void>();
    const discordAdapter = createAdapter("discord");
    discordAdapter.start.mockImplementation(async (listener) => {
      discordAdapter.listener = listener;
      await discordStart.promise;
    });
    const telegramAdapter = createAdapter("telegram");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => [
      ...(config.discord ? [discordAdapter] : []),
      ...(config.telegram ? [telegramAdapter] : []),
    ]);
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }));

    const startPromise = runtime.start();
    await waitFor(() => discordAdapter.start.mock.calls.length === 1);
    const applyPromise = runtime.applyConfig({
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });
    await Promise.all([startPromise, applyPromise]);

    expect(discordAdapter.stop).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "discord",
          health: "suspended",
          reason: "discord was disabled while adapter startup was still pending.",
        }),
        expect.objectContaining({
          platform: "telegram",
          health: "enabled",
        }),
      ]),
    );
    expect(messagingLog.info).toHaveBeenCalledWith(
      "discord: adapter startup cancelled",
      expect.objectContaining({ channel: "discord" }),
    );

    discordStart.resolve();
    await waitFor(() => discordAdapter.stop.mock.calls.length === 2);
    expect(messagingLog.info).toHaveBeenCalledWith(
      "discord: stopped adapter after late startup",
      { channel: "discord" },
    );
  });

  it("serializes config changes behind pending startup", async () => {
    await prepareRuntimeStore();
    const firstTelegramStart = createDeferred<void>();
    const firstTelegramStarting = createDeferred<void>();
    const firstTelegramAdapter = createAdapter("telegram");
    firstTelegramAdapter.start.mockImplementation(async (listener) => {
      firstTelegramAdapter.listener = listener;
      firstTelegramStarting.resolve();
      await firstTelegramStart.promise;
    });
    const secondTelegramAdapter = createAdapter("telegram");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.telegram) return [];
      return [
        config.telegram.botToken === "telegram-token-2"
          ? secondTelegramAdapter
          : firstTelegramAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token-1",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    const startPromise = runtime.start();
    await firstTelegramStarting.promise;
    const applyPromise = runtime.applyConfig({
      telegram: {
        channel: "telegram",
        botToken: "telegram-token-2",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });
    await flushMicrotasks();

    expect(firstTelegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(secondTelegramAdapter.start).not.toHaveBeenCalled();

    firstTelegramStart.resolve();
    await Promise.all([startPromise, applyPromise]);

    expect(firstTelegramAdapter.stop).toHaveBeenCalledTimes(1);
    expect(secondTelegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        platform: "telegram",
        health: "enabled",
      }),
    ]);
  });

  it("isolates backend event delivery failures between adapters", async () => {
    await prepareRuntimeStore();
    const failingAdapter = createAdapter("telegram", {
      deliver: vi.fn(async (
        intent: MessagingSurfaceIntent,
      ): Promise<MessagingDeliveryResult> => {
        if (intent.kind === "message") {
          throw new Error("telegram delivery failed");
        }
        failingAdapter.delivered.push(intent);
        return {
          channel: "telegram",
          deliveredAt: 1000,
          outcome: "presented",
        };
      }),
    });
    const workingAdapter = createAdapter("discord");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const bridge = createBackendBridge();
    const runtime = new Runtime({
      adapterFactory: () => [failingAdapter, workingAdapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await failingAdapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    await workingAdapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }, "discord"),
    );
    failingAdapter.delivered.length = 0;
    workingAdapter.delivered.length = 0;

    await bridge.emitBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [
              {
                type: "text",
                text: "Still delivered elsewhere",
              },
            ],
          },
        },
      },
    });

    expect(messagingLog.error).toHaveBeenCalledWith(
      "messaging controller failed to handle backend event",
      expect.objectContaining({
        backend: "codex",
        method: "turn/completed",
      }),
    );
    expect(workingAdapter.delivered.find((intent) => intent.kind === "message"))
      .toMatchObject({
        kind: "message",
      });
  });

  it("emits health=enabled for each adapter that successfully starts", async () => {
    const { runtime } = await createRuntimeHarness();
    const events: unknown[] = [];
    const unsubscribe = runtime.onPlatformStatus((event) => {
      events.push(event);
    });

    await runtime.start();
    await Promise.resolve();

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "health-changed",
        platform: "telegram",
        health: "enabled",
      }),
    );
    unsubscribe();
  });

  it("emits health=errored when an adapter fails to start", async () => {
    await prepareRuntimeStore();
    const failingAdapter = createAdapter("telegram", {
      start: vi.fn(async () => {
        throw new Error("telegram unavailable");
      }),
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [failingAdapter],
      backendBridge: bridge,
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });
    const events: unknown[] = [];
    runtime.onPlatformStatus((event) => events.push(event));

    await runtime.start();

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "health-changed",
        platform: "telegram",
        health: "errored",
        reason: expect.stringContaining("telegram unavailable"),
      }),
    );
  });

  it("flips health to errored when an adapter signals a runtime error after start", async () => {
    await prepareRuntimeStore();
    let fireRuntimeError: ((reason: string) => void) | undefined;
    const adapter = createAdapter("telegram", {
      onRuntimeError: (listener: (reason: string) => void) => {
        fireRuntimeError = listener;
        return () => {
          fireRuntimeError = undefined;
        };
      },
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    const events: unknown[] = [];
    runtime.onPlatformStatus((event) => events.push(event));

    fireRuntimeError?.(
      "Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running)",
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "health-changed",
        platform: "telegram",
        health: "errored",
        reason: expect.stringContaining("409"),
      }),
    );
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        platform: "telegram",
        health: "errored",
        reason: expect.stringContaining("409"),
      }),
    ]);
  });

  it("emits health=degraded during rate-limit cool-off and reconnect attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    await prepareRuntimeStore();
    let fireRateLimit: ((info: MessagingRateLimitInfo) => void) | undefined;
    let fireReconnect: ((info: MessagingReconnectInfo) => void) | undefined;
    const scope: MessagingDeliveryScope = {
      id: "telegram:group:-100123",
      kind: "group",
      label: "Telegram group -100123",
      platform: "telegram",
    };
    const adapter = createAdapter("telegram", {
      onRateLimit: (listener: (info: MessagingRateLimitInfo) => void) => {
        fireRateLimit = listener;
        return () => {
          fireRateLimit = undefined;
        };
      },
      onReconnect: (listener: (info: MessagingReconnectInfo) => void) => {
        fireReconnect = listener;
        return () => {
          fireReconnect = undefined;
        };
      },
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: createBackendBridge(),
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    try {
      await runtime.start();
      const events: unknown[] = [];
      runtime.onPlatformStatus((event) => events.push(event));

      fireRateLimit?.({
        message: "Too many requests",
        observedAt: 1000,
        retryAfterMs: 5000,
        scope,
      });

      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "degraded",
          platform: "telegram",
          degradationReasons: [
            expect.objectContaining({
              kind: "rate-limited",
              scope: expect.objectContaining({ id: scope.id }),
            }),
          ],
        }),
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({
          health: "degraded",
          platform: "telegram",
          degradationReasons: [
            expect.objectContaining({ kind: "rate-limited" }),
          ],
        }),
      );

      await vi.advanceTimersByTimeAsync(7000);

      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "enabled",
          platform: "telegram",
          degradationReasons: [],
        }),
      ]);

      fireReconnect?.({
        attemptCount: 1,
        lastFailureReason: "socket closed",
        observedAt: Date.now(),
        state: "started",
      });
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "degraded",
          platform: "telegram",
          degradationReasons: [
            expect.objectContaining({
              attemptCount: 1,
              kind: "reconnecting",
            }),
          ],
        }),
      ]);

      fireReconnect?.({ observedAt: Date.now(), state: "recovered" });
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "enabled",
          platform: "telegram",
          degradationReasons: [],
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await runtime.stop();
    }
  }, 30_000);

  it("reports a bot-wide cool-off once, for the bot, however many conversations hit it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    await prepareRuntimeStore();
    let fireRateLimit: ((info: MessagingRateLimitInfo) => void) | undefined;
    const conversation = (id: string): MessagingDeliveryScope => ({
      bucketId: "telegram:bot",
      id: `telegram:group:${id}`,
      kind: "group",
      label: `Telegram group ${id}`,
      platform: "telegram",
    });
    const adapter = createAdapter("telegram", {
      onRateLimit: (listener: (info: MessagingRateLimitInfo) => void) => {
        fireRateLimit = listener;
        return () => {
          fireRateLimit = undefined;
        };
      },
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: createBackendBridge(),
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });
    const reasons = () =>
      runtime.getPlatformStatuses().flatMap((status) => status.degradationReasons ?? []);

    try {
      await runtime.start();
      fireRateLimit?.({
        appliesTo: "bucket",
        observedAt: 1000,
        retryAfterMs: 10_000,
        scope: conversation("-100123"),
      });
      // A shorter bot-wide 429 from another conversation must not shorten it.
      fireRateLimit?.({
        appliesTo: "bucket",
        observedAt: 1000,
        retryAfterMs: 1_000,
        scope: conversation("-100456"),
      });

      expect(reasons()).toEqual([
        expect.objectContaining({
          expiresAt: 1000 + 10_000 + 2_000,
          kind: "rate-limited",
          // The wait left, not the shorter second 429's own.
          retryAfterMs: 10_000,
          scope: expect.objectContaining({
            bucketId: "telegram:bot",
            label: "all conversations",
          }),
        }),
      ]);

      // A limit on one conversation stays its own reason.
      fireRateLimit?.({
        observedAt: 1000,
        retryAfterMs: 1_000,
        scope: conversation("-100789"),
      });
      expect(reasons().map((reason) => reason.scope?.label)).toEqual([
        "all conversations",
        "Telegram group -100789",
      ]);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(reasons()).toEqual([
        expect.objectContaining({
          scope: expect.objectContaining({ label: "all conversations" }),
        }),
      ]);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(reasons()).toEqual([]);

      // A 429 after the reason expired starts a new one; nothing carries over.
      fireRateLimit?.({
        appliesTo: "bucket",
        observedAt: Date.now(),
        retryAfterMs: 1_000,
        scope: conversation("-100123"),
      });
      expect(reasons()).toEqual([
        expect.objectContaining({
          expiresAt: Date.now() + 1_000 + 2_000,
          retryAfterMs: 1_000,
          startedAt: Date.now(),
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await runtime.stop();
    }
  }, 30_000);

  it("restores errored adapter health after an explicit reconnect recovery", async () => {
    await prepareRuntimeStore();
    let fireReconnect: ((info: MessagingReconnectInfo) => void) | undefined;
    let fireRuntimeError: ((reason: string) => void) | undefined;
    const adapter = createAdapter("telegram", {
      onReconnect: (listener: (info: MessagingReconnectInfo) => void) => {
        fireReconnect = listener;
        return () => {
          fireReconnect = undefined;
        };
      },
      onRuntimeError: (listener: (reason: string) => void) => {
        fireRuntimeError = listener;
        return () => {
          fireRuntimeError = undefined;
        };
      },
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: createBackendBridge(),
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    try {
      await runtime.start();
      const events: unknown[] = [];
      runtime.onPlatformStatus((event) => events.push(event));
      fireRuntimeError?.("websocket disconnected");
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "errored",
          platform: "telegram",
          reason: "websocket disconnected",
        }),
      ]);

      fireReconnect?.({ attemptCount: 4, state: "started" });
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "errored",
          platform: "telegram",
        }),
      ]);

      fireReconnect?.({ state: "recovered" });
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "enabled",
          platform: "telegram",
          reason: undefined,
        }),
      ]);
      expect(events.at(-1)).toEqual(
        expect.objectContaining({
          health: "enabled",
          kind: "health-changed",
          platform: "telegram",
        }),
      );
    } finally {
      await runtime.stop();
    }
  }, 30_000);

  it("detaches adapter runtime-error listeners on stop so a graceful shutdown does not flip to errored", async () => {
    await prepareRuntimeStore();
    let fireRuntimeError: ((reason: string) => void) | undefined;
    const adapter = createAdapter("telegram", {
      onRuntimeError: (listener: (reason: string) => void) => {
        fireRuntimeError = listener;
        return () => {
          fireRuntimeError = undefined;
        };
      },
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.stop();

    expect(fireRuntimeError).toBeUndefined();
  });

  it("emits an activity event when an inbound message arrives", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    await runtime.start();
    const events: unknown[] = [];
    runtime.onPlatformStatus((event) => events.push(event));

    await adapter.listener?.(buildCommandEvent("/resume"));

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "activity",
        platform: "telegram",
      }),
    );
  });

  it("logs actionable adapter rejections only after resolving a binding", async () => {
    await prepareRuntimeStore();
    let rejectedListener: MessagingInboundRejectedListener | undefined;
    const adapter = createAdapter("discord", {
      onInboundRejected: (listener: MessagingInboundRejectedListener) => {
        rejectedListener = listener;
        return () => {
          rejectedListener = undefined;
        };
      },
    });
    const bridge = createBackendBridge();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:discord:channel::1480554271907905000:codex:thread-1",
      channel: {
        channel: "discord",
        conversation: {
          id: "1480554271907905000",
          kind: "channel",
          parentId: "1480554271907905731",
          title: "agent-testing",
        },
      },
      targetKind: "agent_thread",
      backend: "codex",
      threadId: "thread-1",
      authorizedActorIds: ["user-1"],
      createdAt: 1000,
      updatedAt: 1000,
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    const rejectedEvent: MessagingRejectedInboundEvent = {
      id: "discord:message:msg-1:rejected",
      kind: "text",
      actor: {
        platformUserId: "1177378744822943744",
        displayName: "Other User",
        username: "other",
      },
      botMention: true,
      channel: {
        channel: "discord",
        conversation: {
          id: "1480554271907905000",
          kind: "channel",
          parentId: "1480554271907905731",
          title: "agent-testing",
        },
      },
      receivedAt: 1234,
      reason: "unauthorized-actor",
    };
    await rejectedListener?.(rejectedEvent);

    const { getAppStateDb } = await import("../state/app-state");
    const row = getAppStateDb().raw
      .prepare(
        `SELECT actor_id, conversation_id, payload
         FROM messaging_activity_log
         WHERE kind = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get("inbound-rejected") as
        | { actor_id: string; conversation_id: string; payload: string }
        | undefined;

    expect(row).toMatchObject({
      actor_id: "1177378744822943744",
      conversation_id: "1480554271907905000",
    });
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
      conversationParentId: "1480554271907905731",
      destinationBackend: "codex",
      destinationThreadId: "thread-1",
      rejectionReason: "unauthorized-actor",
      routeSource: "binding",
    });
    expect(messagingLog.warn).toHaveBeenCalledWith(
      "actionable messaging event rejected for a routed destination",
      expect.objectContaining({
        actorId: "1177378744822943744",
        conversationId: "1480554271907905000",
        conversationDisplayName: "agent-testing",
        conversationTitle: "agent-testing",
        destinationBackend: "codex",
        destinationThreadId: "thread-1",
        reason: "unauthorized-actor",
        routeSource: "binding",
      }),
    );
    await expect(
      getDesktopMessagingStore().findObservedSurfaces(),
    ).resolves.toEqual([
      expect.objectContaining({
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "1480554271907905000",
          }),
        }),
      }),
    ]);
  });

  it("does not log or persist ambient shared-channel rejections", async () => {
    const { reject } = await createSlackRejectedRuntimeHarness();
    await reject(buildRejectedSlackEvent("slack-rejected:ambient"));

    const { getAppStateDb } = await import("../state/app-state");
    const count = getAppStateDb().raw
      .prepare("SELECT COUNT(*) AS count FROM messaging_activity_log WHERE kind = ?")
      .get("inbound-rejected") as { count: number };
    expect(count.count).toBe(0);
    expect(messagingLog.warn).not.toHaveBeenCalledWith(
      "actionable messaging event rejected for a routed destination",
      expect.anything(),
    );
  });

  // Adapter validation failures persist only the host-owned stage and reason.
  // Repeats for that reason cannot consume another row until the cooldown ends.
  it("records redacted adapter validation activity within a per-reason cooldown", async () => {
    const { reject, bridge } = await createSlackRejectedRuntimeHarness();
    const { getDesktopMessagingActivityLog } = await import("../messaging/desktop-messaging-activity-log");
    const activity = getDesktopMessagingActivityLog();
    const interval = 30 * 60 * 1000;
    let clock = 0;
    const monotonicNow = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      await fc.assert(fc.asyncProperty(
        fc.array(fc.record({
          reason: fc.constantFrom("callback-signature" as const, "callback-handle-unavailable" as const),
          elapsed: fc.constantFrom(0, 1, interval - 1, interval, interval + 1),
          requestData: fc.string(),
        }), { minLength: 2, maxLength: 18 }),
        async (steps) => {
          clock += interval;
          const sinceId = activity.list({ limit: 1 })[0]?.id ?? 0;
          const expected: Array<{ at: number; receivedAt: number; reason: string }> = [];
          for (const [index, step] of steps.entries()) {
            clock += step.elapsed;
            const receipt = 1_000 + index;
            const previous = expected.findLast((row) => row.reason === step.reason);
            if (!previous || clock - previous.at >= interval) {
              expected.push({ at: clock, receivedAt: receipt, reason: step.reason });
            }
            const rejection = {
              kind: "validation" as const,
              reason: step.reason,
              receivedAt: receipt,
              id: step.requestData,
              text: step.requestData,
              signature: step.requestData,
              channel: { conversation: { id: step.requestData } },
              actor: { platformUserId: step.requestData },
            };
            await reject(rejection);
            const rows = activity.list({ sinceId }).toReversed();
            expect(rows.map((row) => row.createdAt)).toEqual(expected.map((row) => row.receivedAt));
            expect(rows.map((row) => row.payload)).toEqual(expected.map(({ reason }) => ({
              rejectionStage: "adapter-validation",
              rejectionReason: reason,
            })));
            for (const row of rows) {
              expect(row).toMatchObject({ platform: "slack", kind: "inbound-rejected" });
              expect(row).toMatchObject({
                actorId: undefined,
                actorDisplayName: undefined,
                conversationId: undefined,
                conversationTitle: undefined,
                backend: undefined,
                bindingId: undefined,
                threadId: undefined,
              });
            }
          }
        },
      ), { numRuns: 25 });
    } finally {
      monotonicNow.mockRestore();
    }
    expect(bridge.startTurn).not.toHaveBeenCalled();
  });

  it("writes one activity commit for a burst of identical adapter validation failures", async () => {
    const {
      attachSqliteWriteMetrics,
      measureSqliteWrites,
      SQLITE_WRITE_METRICS_ENV,
    } = await import("../state/sqlite-write-metrics");
    // Attach the same collector that measures the feature after substrate
    // setup. The suite resets modules between tests.
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "");
    useFileBackedStateDb = true;
    const { reject } = await createSlackRejectedRuntimeHarness();
    const { getAppStateDb } = await import("../state/app-state");
    const db = getAppStateDb().raw;
    attachSqliteWriteMetrics({ db, dbPath: db.name });
    const { expectSqliteWriteBudget } = await import("./fixtures/sqlite-write-budget");
    const { writes } = await measureSqliteWrites(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await reject({ kind: "validation", reason: "callback-signature", receivedAt: 1_000 + attempt });
      }
    });
    expect(writes.commits).toBe(1);
    expectSqliteWriteBudget({
      scenario: "messaging-adapter-validation-rejection-burst",
      note: "100 failures in one cooldown. At 48 commits/day per platform and reason, 20,600 bytes/commit projects to about 10.9 MB/day across all 11 wired combinations under sustained failures. No idle writes.",
      writes,
    });
  });

  // A storage failure only backs off retries. The full cooldown starts at
  // the first successful write, even if the database recovers mid-burst.
  it("retries adapter validation activity after a short write failure backoff", async () => {
    const { reject } = await createSlackRejectedRuntimeHarness();
    const {
      getDesktopMessagingActivityLog,
      setDesktopMessagingActivityLogForTests,
    } = await import("../messaging/desktop-messaging-activity-log");
    const activity = getDesktopMessagingActivityLog();
    const record = vi.spyOn(activity, "record").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    setDesktopMessagingActivityLogForTests(activity);
    let clock = 0;
    const monotonicNow = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const report = async (receivedAt: number) => {
      await reject({ kind: "validation", reason: "callback-signature", receivedAt });
    };
    try {
      await report(1);
      expect(activity.list()).toEqual([]);
      clock = 59_999;
      await report(2);
      expect(record).toHaveBeenCalledTimes(1);
      clock = 60_000;
      await report(3);
      expect(activity.list().map((row) => row.createdAt)).toEqual([3]);
      clock += 30 * 60 * 1000 - 1;
      await report(4);
      expect(record).toHaveBeenCalledTimes(2);
      clock += 1;
      await report(5);
      expect(activity.list().map((row) => row.createdAt)).toEqual([5, 3]);
    } finally {
      monotonicNow.mockRestore();
      record.mockRestore();
      setDesktopMessagingActivityLogForTests(null);
    }
  });

  it("does not log or persist an unauthorized mention without a route", async () => {
    const { reject } = await createSlackRejectedRuntimeHarness();
    await reject(buildRejectedSlackEvent(
      "slack-rejected:unroutable-mention",
      true,
    ));

    const { getAppStateDb } = await import("../state/app-state");
    const count = getAppStateDb().raw
      .prepare("SELECT COUNT(*) AS count FROM messaging_activity_log WHERE kind = ?")
      .get("inbound-rejected") as { count: number };
    expect(count.count).toBe(0);
    expect(messagingLog.warn).not.toHaveBeenCalledWith(
      "actionable messaging event rejected for a routed destination",
      expect.anything(),
    );
  });

  it("logs a routed unauthorized DM without requiring a mention", async () => {
    const { reject } = await createSlackRejectedRuntimeHarness();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertDefaultAgentAssignment({
      id: "default-agent:slack-provider",
      scope: { kind: "provider", channel: "slack" },
      target: {
        kind: "agent",
        backend: "codex",
        threadId: "thread-1",
      },
      createdAt: 1000,
      updatedAt: 1000,
    });
    const event = buildRejectedSlackEvent("slack-rejected:routed-dm");
    event.channel.conversation = {
      id: "D012ABCDEF0",
      isDirectMessage: true,
      kind: "dm",
      title: "Other User",
    };

    await reject(event);

    const { getAppStateDb } = await import("../state/app-state");
    const count = getAppStateDb().raw
      .prepare("SELECT COUNT(*) AS count FROM messaging_activity_log WHERE kind = ?")
      .get("inbound-rejected") as { count: number };
    expect(count.count).toBe(1);
    expect(messagingLog.warn).toHaveBeenCalledWith(
      "actionable messaging event rejected for a routed destination",
      expect.objectContaining({
        actorId: "user-2",
        conversationId: "D012ABCDEF0",
        conversationKind: "dm",
        destinationThreadId: "thread-1",
        reason: "unauthorized-actor",
      }),
    );
  });

  it("logs a routed unauthorized mention with friendly conversation and Agent names", async () => {
    const { bridge, reject } = await createSlackRejectedRuntimeHarness();
    bridge.readThreadAgentMetadata = vi.fn(async () => ({
      name: "PwrAgent - hhunt",
      instructionLineCount: 1,
      instructionsTooLong: false,
      updatedAt: 1000,
    }));
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertDefaultAgentAssignment({
      id: "default-agent:slack-provider",
      scope: { kind: "provider", channel: "slack" },
      target: {
        kind: "agent",
        backend: "codex",
        threadId: "thread-1",
      },
      createdAt: 1000,
      updatedAt: 1000,
    });
    await reject(buildRejectedSlackEvent("slack-rejected:routed-mention", true));
    await reject(buildRejectedSlackEvent("slack-rejected:routed-mention-2", true));

    expect(bridge.getNavigationSnapshot).not.toHaveBeenCalled();
    expect(bridge.readThreadAgentMetadata).toHaveBeenCalledTimes(1);

    expect(messagingLog.warn).toHaveBeenCalledWith(
      "actionable messaging event rejected for a routed destination",
      expect.objectContaining({
        actorDisplayName: "Other User",
        conversationId: "C012ABCDEF0",
        conversationDisplayName: "#p-search-signals-projects",
        conversationTitle: "p-search-signals-projects",
        destinationAgentName: "PwrAgent - hhunt",
        destinationBackend: "codex",
        destinationThreadId: "thread-1",
        routeSource: "default-agent",
      }),
    );
    const { getAppStateDb } = await import("../state/app-state");
    const row = getAppStateDb().raw
      .prepare(
        `SELECT conversation_title, summary, payload
         FROM messaging_activity_log
         WHERE kind = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get("inbound-rejected") as
        | { conversation_title: string; payload: string; summary: string }
        | undefined;
    expect(row?.conversation_title).toBe("p-search-signals-projects");
    expect(row?.summary).toBe(
      "Blocked @mention to PwrAgent - hhunt from Other User in #p-search-signals-projects",
    );
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
      destinationAgentName: "PwrAgent - hhunt",
      destinationBackend: "codex",
      destinationThreadId: "thread-1",
      routeSource: "default-agent",
    });
  });

  it("records adapter diagnostics in Messaging Activity", async () => {
    await prepareRuntimeStore();
    let diagnosticListener: MessagingAdapterDiagnosticListener | undefined;
    const adapter = createAdapter("feishu", {
      onDiagnostic: (listener) => {
        diagnosticListener = listener;
        return () => {
          diagnosticListener = undefined;
        };
      },
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {
        feishu: {
          channel: "feishu",
          appId: "cli_test",
          appSecret: "secret",
          tenantUrl: "https://open.larksuite.com",
          callbackBaseUrl: "http://127.0.0.1:47823",
          authorizedActorIds: [],
        },
      },
    });

    await runtime.start();
    await diagnosticListener?.({
      id: "evt_entered",
      platform: "feishu",
      summary: "Feishu / Lark DM opened; waiting for message receive event.",
      observedAt: 1234,
      actor: { platformUserId: "ou_user" },
      channel: {
        channel: "feishu",
        conversation: {
          id: "ou_user",
          kind: "dm",
          parentId: "tenant_1",
        },
      },
      payload: {
        eventType: "im.chat.access_event.bot_p2p_chat_entered_v1",
      },
    });

    const { getAppStateDb } = await import("../state/app-state");
    const row = getAppStateDb().raw
      .prepare(
        `SELECT platform, kind, actor_id, conversation_id, summary, payload
         FROM messaging_activity_log
         WHERE kind = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get("diagnostic") as
        | {
            actor_id: string;
            conversation_id: string;
            kind: string;
            payload: string;
            platform: string;
            summary: string;
          }
        | undefined;

    expect(row).toMatchObject({
      actor_id: "ou_user",
      conversation_id: "ou_user",
      kind: "diagnostic",
      platform: "feishu",
      summary: "Feishu / Lark DM opened; waiting for message receive event.",
    });
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
      eventId: "evt_entered",
      eventType: "im.chat.access_event.bot_p2p_chat_entered_v1",
    });
  });

  it("resolves a delivery diagnostic title from the explicit peer without reading fleet navigation", async () => {
    const { runtime, bridge } = await createRuntimeHarness();
    const target = { scope: "remote" as const, instanceId: "peer" };
    const read = vi.fn<NonNullable<MessagingBackendBridge["getNavigationSelectedDetail"]>>(async (request) => ({
      protocol: 2, ref: request.ref, revision: "owner", readiness: "ready", identity: "present",
      thread: { ...buildNavigationSnapshot().threads[0]!, title: "Peer title" },
    }));
    bridge.getNavigationSelectedDetail = read;
    const resolveTitle = (runtime as unknown as {
      resolveDeliveryBudgetThreadTitle: (event: MessagingControllerDeliveryBudgetEvent) => Promise<string | undefined>;
    }).resolveDeliveryBudgetThreadTitle.bind(runtime);
    const event: MessagingControllerDeliveryBudgetEvent = {
      at: Date.now(), backend: "codex", threadId: "thread-1", federationTarget: target,
      channel: "telegram", intentId: "status", intentKind: "status", outcome: "dropped", priority: "routine_status", slowMode: false,
    };
    expect(await resolveTitle(event)).toBe("Peer title");
    expect(read).toHaveBeenCalledWith({ protocol: 2, federationTarget: target,
      ref: { backend: "codex", threadId: "thread-1", ownerInstanceId: "peer" } });
    read.mockResolvedValueOnce({ protocol: 2, ref: { backend: "codex", threadId: "thread-1" },
      revision: "local", readiness: "ready", identity: "present", thread: buildNavigationSnapshot().threads[0] });
    expect(await resolveTitle(event)).toBeUndefined();
    expect(bridge.getNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("names the constrained binding in delivery budget diagnostics", async () => {
    const { runtime, bridge } = await createRuntimeHarness();
    bridge.getNavigationSelectedDetail = vi.fn<NonNullable<MessagingBackendBridge["getNavigationSelectedDetail"]>>(async (request) => ({
      protocol: 2, ref: request.ref, revision: "owner", readiness: "ready", identity: "present",
      thread: buildNavigationSnapshot().threads.find((thread) => thread.id === request.ref.threadId),
    }));
    await runtime.start();

    const event: MessagingControllerDeliveryBudgetEvent = {
      at: Date.now(),
      backend: "codex",
      bindingId: "binding:telegram:topic:-1003841603622:10345:codex:thread-1",
      channel: "telegram",
      conversation: {
        id: "10345",
        kind: "topic",
        parentId: "-1003841603622",
        parentTitle: "PwrAgent Mini Dev Group",
        title: "Test Thread",
      },
      intentId: "status:1",
      intentKind: "status",
      outcome: "dropped",
      priority: "routine_status",
      reason: "budget-exhausted",
      scope: {
        platform: "telegram",
        id: "telegram:group:-1003841603622",
        kind: "group",
        label: "PwrAgent Mini Dev",
      },
      slowMode: true,
      threadId: "thread-1",
    };
    const handleDeliveryBudgetEvent = (
      runtime as unknown as {
        handleDeliveryBudgetEvent: (
          event: MessagingControllerDeliveryBudgetEvent,
        ) => Promise<void>;
      }
    ).handleDeliveryBudgetEvent.bind(runtime);

    await handleDeliveryBudgetEvent(event);
    await handleDeliveryBudgetEvent({
      ...event,
      at: event.at + 1000,
      bindingId: "binding:telegram:topic:-1003841603622:9387:codex:thread-2",
      conversation: {
        id: "9387",
        kind: "topic",
        parentId: "-1003841603622",
        parentTitle: "PwrAgent Mini Dev Group",
        title: "Release Thread",
      },
      intentId: "status:2",
      threadId: "thread-2",
    });

    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        health: "degraded",
        degradationReasons: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("conversation PwrAgent Mini Dev Group / Test Thread"),
            scope: expect.objectContaining({
              id: "telegram:group:-1003841603622",
            }),
          }),
          expect.objectContaining({
            message: expect.stringContaining("conversation PwrAgent Mini Dev Group / Release Thread"),
            scope: expect.objectContaining({
              id: "telegram:group:-1003841603622",
            }),
          }),
        ]),
      }),
    ]);
    expect(runtime.getPlatformStatuses()[0]?.degradationReasons).toHaveLength(2);

    const { getAppStateDb } = await import("../state/app-state");
    const rows = getAppStateDb().raw
      .prepare(
        `SELECT binding_id, conversation_id, conversation_title, thread_id, summary, payload
         FROM messaging_activity_log
         WHERE kind = ?
         ORDER BY id DESC
         LIMIT 2`,
      )
      .all("diagnostic") as
        {
            binding_id: string;
            conversation_id: string | null;
            conversation_title: string | null;
            payload: string;
            summary: string;
            thread_id: string;
          }[];

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      binding_id: "binding:telegram:topic:-1003841603622:9387:codex:thread-2",
      summary: expect.stringContaining("conversation PwrAgent Mini Dev Group / Release Thread"),
      thread_id: "thread-2",
    });
    expect(rows[1]).toMatchObject({
      binding_id: event.bindingId,
      conversation_id: "10345",
      conversation_title: "PwrAgent Mini Dev Group / Test Thread",
      summary: expect.stringContaining("conversation PwrAgent Mini Dev Group / Test Thread"),
      thread_id: "thread-1",
    });
    expect(JSON.parse(rows[1]?.payload ?? "{}")).toMatchObject({
      bindingId: event.bindingId,
      conversationKind: "topic",
      conversationParentId: "-1003841603622",
      conversationTitle: "PwrAgent Mini Dev Group / Test Thread",
      localThreadTitle: "Thread one",
      scopeId: "telegram:group:-1003841603622",
      scopeKind: "group",
      threadId: "thread-1",
    });
  });

  it("surfaces a budget-starved approval with an operator-legible reason", async () => {
    const { runtime } = await createRuntimeHarness();
    await runtime.start();

    const event: MessagingControllerDeliveryBudgetEvent = {
      at: Date.now(),
      backend: "codex",
      bindingId: "binding:telegram:topic:-1003841603622:10345:codex:thread-1",
      channel: "telegram",
      conversation: {
        id: "10345",
        kind: "topic",
        parentId: "-1003841603622",
        parentTitle: "PwrAgent Mini Dev Group",
        title: "Approval Thread",
      },
      intentId: "approval:d778bf36",
      intentKind: "approval",
      outcome: "deferred",
      priority: "critical_interactive",
      reason: "budget-exhausted",
      retryAt: Date.now() + 12_000,
      scope: {
        platform: "telegram",
        id: "telegram:group:-1003841603622",
        kind: "group",
        label: "PwrAgent Mini Dev",
      },
      slowMode: true,
      threadId: "thread-1",
    };
    const handleDeliveryBudgetEvent = (
      runtime as unknown as {
        handleDeliveryBudgetEvent: (
          event: MessagingControllerDeliveryBudgetEvent,
        ) => Promise<void>;
      }
    ).handleDeliveryBudgetEvent.bind(runtime);

    await handleDeliveryBudgetEvent(event);

    // The live status names the approval, not the raw `critical_interactive`
    // scheduling token, so a starved approval reads as a clear reason.
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        degradationReasons: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("approval / interactive prompt"),
          }),
        ]),
      }),
    ]);

    const { getAppStateDb } = await import("../state/app-state");
    const rows = getAppStateDb().raw
      .prepare(
        `SELECT summary FROM messaging_activity_log
         WHERE kind = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .all("diagnostic") as { summary: string }[];
    expect(rows[0]?.summary).toContain("approval / interactive prompt");
    expect(rows[0]?.summary).not.toContain("critical_interactive");
  });

  it.each([true, false])("pairs a Telegram link only with its original account (identity lookup available: %s)", async (canAdvertise) => {
    let accountId = "1001";
    let advertise = true;
    const pairingIdentity = { readDmPairingAccountId: () => accountId };
    const adapter = createAdapter("telegram", {
      ...pairingIdentity,
      readDmPairingAddress: () => advertise ? {
        accountId,
        linkForToken: (token) => `https://t.me/example_fixture_bot?start=pair_${token}`,
      } : undefined,
    });
    const { runtime } = await createRuntimeHarness({ adapter });
    await runtime.start();
    const result = runtime.generatePairingToken({ platform: "telegram", scope: "user_dm" });
    expect(result.dmLink?.url).toBe(`https://t.me/example_fixture_bot?start=pair_${result.token}`);
    expect(result.dmLink?.qrImage).toMatch(/^data:image\/svg\+xml,/);
    expect(runtime.generatePairingToken({ platform: "telegram", scope: "bucket" }).dmLink).toBeUndefined();

    const receive = () => adapter.listener?.({
      id: "telegram:update:40:message:41",
      kind: "command",
      actor: { platformUserId: "1234" },
      channel: { channel: "telegram", conversation: { id: "1234", kind: "dm" } },
      command: "pair",
      args: [result.token],
      rawText: "/pair",
      receivedAt: 1000,
    });
    const entry = () => runtime.listPairingRequests({ platform: "telegram" }).entries
      .find((candidate) => candidate.id === result.entry.id)!;

    accountId = "1002";
    advertise = canAdvertise;
    await receive();
    expect(entry().status).toBe("pending");
    expect(runtime.getPairingAccountStatus(entry())).toBe("different");

    accountId = "1001";
    await receive();
    expect(entry().status).toBe("observed");
    expect(runtime.getPairingAccountStatus(entry())).toBe("current");
  });

  it("logs Telegram topic pairing activity with supergroup parent metadata", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    await runtime.start();
    const { token } = runtime.generatePairingToken({
      platform: "telegram",
      scope: "bucket",
    });

    await adapter.listener?.({
      id: "telegram:update:1:message:2",
      kind: "command",
      actor: {
        platformUserId: "8460800771",
        displayName: "Harold Hunt",
        username: "fixtureuser",
      },
      args: [token],
      channel: {
        channel: "telegram",
        conversation: {
          id: "5642",
          kind: "topic",
          parentId: "-1003841603622",
          title: "Release",
          parentTitle: "PwrDrvr",
        },
      },
      command: "pair",
      rawText: `/pair ${token}`,
      receivedAt: 1000,
      routingState: {
        opaque: {
          chatId: -1003841603622,
          messageThreadId: 5642,
        },
      },
    });

    const observed = runtime.listPairingRequests({ platform: "telegram" }).entries[0];
    expect(observed).toMatchObject({
      status: "observed",
      observedChat: {
        id: "5642",
        kind: "topic",
        parentId: "-1003841603622",
        bucketId: "-1003841603622",
      },
    });

    const { getAppStateDb } = await import("../state/app-state");
    const row = getAppStateDb().raw
      .prepare(
        `SELECT conversation_id, actor_id, payload
         FROM messaging_activity_log
         WHERE kind = ? AND summary = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get("pairing", "Observed pairing token") as
        | { actor_id: string; conversation_id: string; payload: string }
        | undefined;

    expect(row).toMatchObject({
      actor_id: "8460800771",
      conversation_id: "5642",
    });
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
      conversationKind: "topic",
      conversationParentId: "-1003841603622",
      conversationBucketId: "-1003841603622",
      actorUsername: "fixtureuser",
    });
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await expect(getDesktopMessagingStore().findObservedSurfaces()).resolves
      .toEqual([
        expect.objectContaining({
          channel: expect.objectContaining({
            channel: "telegram",
            conversation: expect.objectContaining({
              id: "5642",
              parentId: "-1003841603622",
              title: "Release",
            }),
          }),
        }),
      ]);
  });

  it("emits health=suspended for each running adapter when stopped", async () => {
    const { runtime } = await createRuntimeHarness();
    await runtime.start();
    const events: unknown[] = [];
    runtime.onPlatformStatus((event) => events.push(event));

    await runtime.stop();

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "health-changed",
        platform: "telegram",
        health: "suspended",
      }),
    );
  });

  it("getPlatformStatuses returns a snapshot keyed by platform", async () => {
    const { runtime } = await createRuntimeHarness();
    await runtime.start();

    const snapshot = runtime.getPlatformStatuses();
    expect(snapshot).toEqual([
      expect.objectContaining({
        platform: "telegram",
        health: "enabled",
      }),
    ]);
  });

  it("requestBindingRevoke routes through the controller so the platform adapter receives a Thread-detached confirmation", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );

    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    const store = getDesktopMessagingStore();
    const binding = await store.findActiveBindingForChannel({
      channel: "telegram",
      conversation: { id: "chat-1", kind: "dm" },
    });
    expect(binding).toBeDefined();

    adapter.delivered.length = 0;

    const result = await runtime.requestBindingRevoke({
      bindingId: binding!.id,
      origin: "ui",
    });

    expect(result).toEqual({ revoked: true, notifiedPlatform: true });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Thread detached",
    });
    await expect(store.getBinding(binding!.id)).resolves.toMatchObject({
      revokedAt: expect.any(Number),
    });
  });

  it("requestBindingRevoke falls back to a store-only revoke when no controller scopes the binding's channel", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );

    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    const store = getDesktopMessagingStore();
    const binding = await store.findActiveBindingForChannel({
      channel: "telegram",
      conversation: { id: "chat-1", kind: "dm" },
    });
    expect(binding).toBeDefined();

    await runtime.stop();
    adapter.delivered.length = 0;

    const result = await runtime.requestBindingRevoke({
      bindingId: binding!.id,
      origin: "ui",
    });

    expect(result).toEqual({ revoked: true, notifiedPlatform: false });
    expect(adapter.delivered).toHaveLength(0);
    await expect(store.getBinding(binding!.id)).resolves.toMatchObject({
      revokedAt: expect.any(Number),
    });
  });

  it("requestBindingRevoke is a no-op for unknown or already-revoked bindings", async () => {
    const { runtime } = await createRuntimeHarness();
    await runtime.start();

    const result = await runtime.requestBindingRevoke({
      bindingId: "binding:does-not-exist",
      origin: "ui",
    });
    expect(result).toEqual({ revoked: false, notifiedPlatform: false });
  });

  it.each(["detach", "archive"] as const)("lists and revokes offline named bindings on %s", async (action) => {
    await prepareRuntimeStore();
    const { DesktopMessagingRuntime: Runtime } = await import("../messaging/messaging-runtime");
    const { openMessagingConnectionStorage } = await import("../storage/desktop-messaging-storage");
    const id = `mc_${"a".repeat(32)}`;
    const other = `mc_${"b".repeat(32)}`;
    const first = openMessagingConnectionStorage(id);
    const second = openMessagingConnectionStorage(other);
    try {
      for (const [connectionId, scope] of [[id, first], [other, second]] as const) {
        await scope.bindings.upsertBinding({
          id: "same-binding", backend: "codex", threadId: "thread-1",
          channel: { channel: "telegram", connectionId, conversation: { kind: "dm", id: "42" } },
          authorizedActorIds: ["42"], createdAt: 1, updatedAt: 1,
        });
      }
      const runtime = trackRuntime(new Runtime({
        adapterFactory: () => [], config: {}, backendBridge: createBackendBridge(),
        readSavedTelegramConnectionIds: async () => [id, other],
      }));
      expect(await runtime.listNamedBindings(undefined, true)).toHaveLength(2);
      if (action === "detach") {
        await expect(runtime.requestBindingRevoke({ bindingId: "same-binding", connectionId: id, origin: "ui" }))
          .resolves.toEqual({ revoked: true, notifiedPlatform: false });
      } else {
        await expect(runtime.requestBindingRevokeAllForThread({ backend: "codex", threadId: "thread-1", origin: "ui" }))
          .resolves.toEqual({ revokedCount: 2, notifiedCount: 0 });
      }
      expect(await first.bindings.findActiveBindings()).toHaveLength(0);
      expect(await second.bindings.findActiveBindings()).toHaveLength(action === "detach" ? 1 : 0);
    } finally {
      first.close();
      second.close();
    }
  });

  it("requestBindingRevokeAllForThread fans out to every binding on the thread, regardless of platform", async () => {
    await prepareRuntimeStore();
    const telegramAdapter = createAdapter("telegram");
    const discordAdapter = createAdapter("discord");
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [telegramAdapter, discordAdapter],
      backendBridge: bridge,
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        discord: {
          channel: "discord",
          botToken: "discord-token",
          applicationId: "app-1",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });
    await runtime.start();

    await telegramAdapter.listener?.(
      buildCallbackEvent(
        "bind:codex:thread-1",
        { backend: "codex", threadId: "thread-1" },
        "telegram",
      ),
    );
    await discordAdapter.listener?.(
      buildCallbackEvent(
        "bind:codex:thread-1",
        { backend: "codex", threadId: "thread-1" },
        "discord",
      ),
    );

    telegramAdapter.delivered.length = 0;
    discordAdapter.delivered.length = 0;

    const result = await runtime.requestBindingRevokeAllForThread({
      backend: "codex",
      threadId: "thread-1",
      origin: "thread-archive",
    });

    expect(result).toEqual({ revokedCount: 2, notifiedCount: 2 });
    expect(telegramAdapter.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Thread detached",
    });
    expect(discordAdapter.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Thread detached",
    });
  });

  it("stops the started adapter instances without rebuilding the factory", async () => {
    await prepareRuntimeStore();
    const adapter = createAdapter("telegram");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(() => [adapter]);
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.stop();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(adapter.stop).toHaveBeenCalledTimes(1);
  });

  it("hot-applies config by leaving unchanged adapters alone and starting new channels", async () => {
    await prepareRuntimeStore();
    const telegramAdapter = createAdapter("telegram");
    const discordAdapter = createAdapter("discord");
    const slackAdapter = createAdapter("slack");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => [
      ...(config.telegram ? [telegramAdapter] : []),
      ...(config.discord ? [discordAdapter] : []),
      ...(config.slack ? [slackAdapter] : []),
    ]);
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
      discord: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
      slack: {
        channel: "slack",
        botToken: "slack-bot-token",
        appToken: "slack-app-token",
        inboundMode: "socket",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });

    expect(telegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(telegramAdapter.stop).not.toHaveBeenCalled();
    expect(discordAdapter.start).toHaveBeenCalledTimes(1);
    expect(slackAdapter.start).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: "telegram", health: "enabled" }),
        expect.objectContaining({ platform: "discord", health: "enabled" }),
        expect.objectContaining({ platform: "slack", health: "enabled" }),
      ]),
    );
  });

  it("hot-applies Slack config changes by restarting the running adapter", async () => {
    await prepareRuntimeStore();
    const firstSlackAdapter = createAdapter("slack");
    const secondSlackAdapter = createAdapter("slack");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.slack) return [];
      return [
        config.slack.botToken === "slack-bot-token-2"
          ? secondSlackAdapter
          : firstSlackAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        slack: {
          channel: "slack",
          botToken: "slack-bot-token-1",
          appToken: "slack-app-token",
          inboundMode: "socket",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      slack: {
        channel: "slack",
        botToken: "slack-bot-token-2",
        appToken: "slack-app-token",
        inboundMode: "socket",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });

    expect(firstSlackAdapter.stop).toHaveBeenCalledTimes(1);
    expect(secondSlackAdapter.start).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        platform: "slack",
        health: "enabled",
      }),
    ]);
  });

  it("hot-applies authorization changes without restarting the running adapter", async () => {
    await prepareRuntimeStore();
    const updateAuthorization = vi.fn(async () => undefined);
    const telegramAdapter = createAdapter("telegram", {
      updateAuthorization,
      updateRenderingPreferences: vi.fn(async () => undefined),
    });
    const replacementTelegramAdapter = createAdapter("telegram");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.telegram) return [];
      return [
        config.telegram.authorizedActorIds.length > 1
          ? replacementTelegramAdapter
          : telegramAdapter,
      ];
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: bridge,
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
          authorizedSupergroupIds: [{ id: "-1001", displayName: "" }],
        },
      },
    });

    await runtime.start();
    vi.mocked(bridge.getNavigationQueryPage!).mockClear();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [
          { id: "user-1", displayName: "" },
          { id: "user-2", displayName: "" },
        ],
        authorizedSupergroupIds: [
          { id: "-1001", displayName: "" },
          { id: "-1002", displayName: "" },
        ],
      },
    });
    await telegramAdapter.listener?.({
      ...buildCommandEvent("/resume"),
      actor: { platformUserId: "user-2" },
    });

    expect(telegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(telegramAdapter.stop).not.toHaveBeenCalled();
    expect(telegramAdapter.updateAuthorization).toHaveBeenCalledWith({
      authorizedActorIds: ["user-1", "user-2"],
      authorizedConversationIds: ["-1001", "-1002"],
      responseMode: undefined,
      conversationResponseModes: [],
    });
    expect(replacementTelegramAdapter.start).not.toHaveBeenCalled();
    expect(bridge.getNavigationQueryPage).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 2, consumer: "messaging-browse", pageSize: 8,
      query: expect.objectContaining({ kind: "messaging-threads" }),
    }));
    expect(bridge.getNavigationSnapshot).not.toHaveBeenCalled();
    expect(messagingLog.info).toHaveBeenCalledWith(
      "telegram: hot-applied messaging config",
      expect.objectContaining({
        channel: "telegram",
        changedFields: [
          "telegram.authorizedActorIds",
          "telegram.authorizedSupergroupIds",
        ],
      }),
    );
  });

  it("hot-applies Slack actor metadata without restarting the running adapter", async () => {
    await prepareRuntimeStore();
    const updateAuthorization = vi.fn(async () => undefined);
    const slackAdapter = createAdapter("slack", { updateAuthorization });
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) =>
      config.slack ? [slackAdapter] : [],
    );
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        slack: {
          channel: "slack",
          botToken: "slack-bot-token",
          authorizedActorIds: [{ id: "U012ABCDEF0", displayName: "Harold" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      slack: {
        channel: "slack",
        botToken: "slack-bot-token",
        authorizedActorIds: [{
          id: "U012ABCDEF0",
          displayName: "Harold Hunt",
          username: "hhunt",
        }],
      },
    });

    expect(slackAdapter.start).toHaveBeenCalledTimes(1);
    expect(slackAdapter.stop).not.toHaveBeenCalled();
    expect(updateAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      authorizedActorIds: ["U012ABCDEF0"],
      authorizedActors: [{
        platformUserId: "U012ABCDEF0",
        displayName: "Harold Hunt",
        username: "hhunt",
      }],
    }));
  });

  it("restarts on authorization changes when the adapter has no hot-update hook", async () => {
    await prepareRuntimeStore();
    const firstTelegramAdapter = createAdapter("telegram");
    const secondTelegramAdapter = createAdapter("telegram");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.telegram) return [];
      return [
        config.telegram.authorizedActorIds.length > 1
          ? secondTelegramAdapter
          : firstTelegramAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [
          { id: "user-1", displayName: "" },
          { id: "user-2", displayName: "" },
        ],
      },
    });

    expect(firstTelegramAdapter.stop).toHaveBeenCalledTimes(1);
    expect(secondTelegramAdapter.start).toHaveBeenCalledTimes(1);
  });

  it("hot-applies LINE authorization changes without restarting the running adapter", async () => {
    await prepareRuntimeStore();
    const updateAuthorization = vi.fn(async () => undefined);
    const lineAdapter = createAdapter("line", {
      updateAuthorization,
      updateRenderingPreferences: vi.fn(async () => undefined),
    });
    const replacementLineAdapter = createAdapter("line");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.line) return [];
      return [
        config.line.authorizedActorIds.some((actor) => actor.id === "user-2")
          ? replacementLineAdapter
          : lineAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        line: {
          channel: "line",
          channelAccessToken: "line-token",
          channelSecret: "line-secret",
          callbackBaseUrl: "http://127.0.0.1:47822/",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
          authorizedGroupIds: [{ id: "C0123456789abcdef0123456789abcdef", displayName: "" }],
          authorizedRoomIds: [{ id: "R0123456789abcdef0123456789abcdef", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      line: {
        channel: "line",
        channelAccessToken: "line-token",
        channelSecret: "line-secret",
        callbackBaseUrl: "http://127.0.0.1:47822/",
        authorizedActorIds: [{ id: "user-2", displayName: "" }],
        authorizedGroupIds: [{ id: "C22222222222222222222222222222222", displayName: "" }],
        authorizedRoomIds: [{ id: "R22222222222222222222222222222222", displayName: "" }],
      },
    });

    expect(lineAdapter.start).toHaveBeenCalledTimes(1);
    expect(lineAdapter.stop).not.toHaveBeenCalled();
    expect(lineAdapter.updateAuthorization).toHaveBeenCalledWith({
      authorizedActorIds: ["user-2"],
      authorizedConversationIds: [
        "C22222222222222222222222222222222",
        "R22222222222222222222222222222222",
      ],
    });
    expect(replacementLineAdapter.start).not.toHaveBeenCalled();
  });

  it("hot-applies config by stopping disabled channels and restarting changed credentials", async () => {
    await prepareRuntimeStore();
    const firstTelegramAdapter = createAdapter("telegram", {
      readCredentialMetadata: () => ({
        account: "@old_bot",
        detail: "api.telegram.org",
      }),
    });
    const secondTelegramAdapter = createAdapter("telegram", {
      readCredentialMetadata: () => ({
        account: "@new_bot",
        detail: "api.telegram.org",
      }),
    });
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.telegram) return [];
      return [
        config.telegram.botToken === "telegram-token-2"
          ? secondTelegramAdapter
          : firstTelegramAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token-1",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token-2",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });
    await runtime.applyConfig({
      inputDebounceMs: 0,
      enabled: false,
    });

    expect(firstTelegramAdapter.stop).toHaveBeenCalledTimes(1);
    expect(secondTelegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(secondTelegramAdapter.stop).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        platform: "telegram",
        health: "suspended",
      }),
    ]);
    expect(runtime.getPlatformStatuses()[0]).not.toHaveProperty("account");
    expect(runtime.getPlatformCredentialMetadata("telegram")).toBeUndefined();
  });

  it("preserves errored health when a hot restart replacement fails", async () => {
    await prepareRuntimeStore();
    const firstTelegramAdapter = createAdapter("telegram", {
      readCredentialMetadata: () => ({
        account: "@old_bot",
        detail: "api.telegram.org",
      }),
    });
    const failingTelegramAdapter = createAdapter("telegram", {
      start: vi.fn(async () => {
        throw new Error("new token rejected");
      }),
    });
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.telegram) return [];
      return [
        config.telegram.botToken === "telegram-token-2"
          ? failingTelegramAdapter
          : firstTelegramAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token-1",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token-2",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });

    expect(firstTelegramAdapter.stop).toHaveBeenCalledTimes(1);
    expect(failingTelegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        platform: "telegram",
        health: "errored",
        reason: "new token rejected",
      }),
    ]);
    expect(runtime.getPlatformStatuses()[0]).not.toHaveProperty("account");
    expect(runtime.getPlatformCredentialMetadata("telegram")).toBeUndefined();
  });
});

async function createSlackRejectedRuntimeHarness(): Promise<{
  bridge: ReturnType<typeof createBackendBridge>;
  reject: (event: MessagingRejectedInboundEvent) => Promise<void>;
}> {
  await prepareRuntimeStore();
  let rejectedListener: MessagingInboundRejectedListener | undefined;
  const adapter = createAdapter("slack", {
    onInboundRejected: (listener: MessagingInboundRejectedListener) => {
      rejectedListener = listener;
      return () => {
        rejectedListener = undefined;
      };
    },
  });
  const bridge = createBackendBridge();
  const { DesktopMessagingRuntime: Runtime } = await import(
    "../messaging/messaging-runtime"
  );
  const runtime = trackRuntime(new Runtime({
    adapterFactory: () => [adapter],
    backendBridge: bridge,
    config: {
      slack: {
        channel: "slack",
        appToken: "slack-app-token",
        botToken: "slack-bot-token",
        signingSecret: "slack-signing-secret",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    },
  }));
  await runtime.start();
  return {
    bridge,
    reject: async (event) => {
      await rejectedListener?.(event);
    },
  };
}

function buildRejectedSlackEvent(
  id: string,
  botMention = false,
): MessagingAuthorizationRejection {
  return {
    id,
    kind: "text",
    actor: {
      platformUserId: "user-2",
      displayName: "Other User",
    },
    ...(botMention ? { botMention: true } : {}),
    channel: {
      channel: "slack",
      conversation: {
        id: "C012ABCDEF0",
        kind: "channel",
        title: "p-search-signals-projects",
      },
    },
    receivedAt: 1234,
    reason: "unauthorized-actor",
  };
}

function buildFullAccessRuntimeConfig(
  allowThreadResume: boolean,
): DesktopMessagingConfig {
  return {
    inputDebounceMs: 0,
    fullAccessControls: {
      allowEscalation: true,
      allowThreadResume,
      warningPolicy: "dismissable",
      authorizedUsers: {
        telegram: [{ id: "user-1", displayName: "" }],
      },
    },
    telegram: {
      channel: "telegram",
      botToken: "telegram-token",
      authorizedActorIds: [{ id: "user-1", displayName: "" }],
    },
  };
}

async function createFullAccessRuntimeHarness(
  config: DesktopMessagingConfig | DesktopMessagingConfigLoader,
): Promise<{
  adapter: ReturnType<typeof createAdapter>;
  bridge: ReturnType<typeof createBackendBridge>;
  runtime: DesktopMessagingRuntime;
}> {
  await prepareRuntimeStore();
  const adapter = createAdapter("telegram");
  const bridge = createBackendBridge();
  const navigation = buildNavigationSnapshot();
  vi.mocked(bridge.readNavigationFixturePopulation).mockResolvedValue({
    ...navigation,
    threads: [{
      ...navigation.threads[0]!,
      executionMode: "full-access",
    }],
  });
  const { DesktopMessagingRuntime: Runtime } = await import(
    "../messaging/messaging-runtime"
  );
  const runtime = trackRuntime(new Runtime({
    adapterFactory: () => [adapter],
    backendBridge: bridge,
    config,
  }));
  const { getDesktopMessagingStore } = await import(
    "../messaging/desktop-messaging-store"
  );
  await getDesktopMessagingStore().upsertBinding({
    id: "binding:full-access",
    channel: {
      channel: "telegram",
      conversation: { id: "chat-1", kind: "dm" },
    },
    backend: "codex",
    threadId: "thread-1",
    authorizedActorIds: ["user-1"],
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  return { adapter, bridge, runtime };
}

async function createRuntimeHarness(options: {
  adapter?: ReturnType<typeof createAdapter>;
} = {}): Promise<{
  DesktopMessagingRuntime: typeof DesktopMessagingRuntime;
  adapter: ReturnType<typeof createAdapter>;
  bridge: ReturnType<typeof createBackendBridge>;
  emitBackendEvent: (event: AgentEvent) => Promise<void>;
  runtime: DesktopMessagingRuntime;
}> {
  await prepareRuntimeStore();

  const adapter = options.adapter ?? createAdapter("telegram");
  const bridge = createBackendBridge();
  const { DesktopMessagingRuntime: Runtime } = await import(
    "../messaging/messaging-runtime"
  );
  const runtime = trackRuntime(
    new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }),
  );

  return {
    DesktopMessagingRuntime: Runtime,
    adapter,
    bridge,
    emitBackendEvent: bridge.emitBackendEvent,
    runtime,
  };
}

async function prepareRuntimeStore(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-runtime-"));
  tempDirs.push(tempDir);
  vi.stubEnv("PWRAGENT_HOME", tempDir);
  const { initializeAppState, resetAppStateForTests } = await import(
    "../state/app-state"
  );
  resetAppStateForTests();
  initializeAppState();
  const { resetDesktopMessagingStoreForTests } = await import(
    "../messaging/desktop-messaging-store"
  );
  resetDesktopMessagingStoreForTests();
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createAdapter(
  channel: MessagingChannelKind,
  overrides: Partial<DesktopMessagingAdapter> = {},
): DesktopMessagingAdapter & {
  delivered: MessagingSurfaceIntent[];
  listener?: (event: MessagingInboundEvent) => Promise<void>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const delivered: MessagingSurfaceIntent[] = [];
  const adapter = {
    authorizedActorIds: ["user-1"],
    capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    channel,
    delivered,
    deliver: vi.fn(async (intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult> => {
      delivered.push(intent);
      return {
        channel,
        deliveredAt: 1000,
        outcome: "presented",
        surface: {
          channel,
          id: `${channel}:${intent.id}`,
        },
      };
    }),
    start: vi.fn(async (listener: (event: MessagingInboundEvent) => Promise<void>) => {
      adapter.listener = listener;
    }),
    stop: vi.fn(async () => {}),
  } as DesktopMessagingAdapter & {
    delivered: MessagingSurfaceIntent[];
    listener?: (event: MessagingInboundEvent) => Promise<void>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  Object.assign(adapter, overrides);

  return adapter;
}

function createBackendBridge(): MessagingBackendBridge & {
  readNavigationFixturePopulation: () => Promise<NavigationSnapshot>;
  emitBackendEvent: (event: AgentEvent) => Promise<void>;
  onEvent: (listener: (event: AgentEvent) => void | Promise<void>) => () => void;
  setRemoteEventSubscriptions: (
    subscriptions: readonly FederationEventSubscription[],
  ) => void;
} {
  const backendListeners = new Set<(event: AgentEvent) => void | Promise<void>>();

  const bridge: ReturnType<typeof createBackendBridge> = {
    readNavigationFixturePopulation: vi.fn(async () => buildNavigationSnapshot()),
    getNavigationSnapshot: vi.fn(async () => { throw new Error("Legacy navigation is forbidden in modern messaging"); }),
    ...boundedMessagingNavigation(() => bridge.readNavigationFixturePopulation()),
    // Production reads a thread's `agent` from its overlay row on BOTH the
    // navigation path and the admission path, so a fixture whose admission
    // state disagrees with its own navigation describes a state the app
    // cannot reach. Resolve from whatever snapshot this bridge is serving,
    // and answer for the thread that was actually asked about.
    getThreadAdmissionState: vi.fn(async (request) => {
      const navigation = await bridge.readNavigationFixturePopulation();
      const thread = navigation.threads.find(
        (candidate) =>
          candidate.source === request.backend
          && candidate.id === request.threadId,
      );
      return thread ? { thread } : {};
    }),
    startTurn: vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-1",
    })),
    onEvent: vi.fn((listener: (event: AgentEvent) => void | Promise<void>) => {
      backendListeners.add(listener);
      return () => {
        backendListeners.delete(listener);
      };
    }),
    setRemoteEventSubscriptions: vi.fn(),
    emitBackendEvent: async (event: AgentEvent) => {
      await Promise.all(
        [...backendListeners].map(async (listener) => {
          await listener(event);
        }),
      );
    },
  };
  return bridge;
}

function buildNavigationSnapshot(): NavigationSnapshot {
  return {
    backend: "all",
    fetchedAt: 1000,
    unchanged: false,
    threads: [
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
        inbox: {
          inInbox: false,
        },
      },
    ],
    inboxThreadKeys: [],
    directories: [],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
  };
}

function buildCommandEvent(rawText: string): MessagingInboundEvent & { kind: "command" } {
  const command = rawText.replace(/^\//, "").split(/\s+/, 1)[0] ?? "";
  return {
    id: "event-command",
    kind: "command",
    actor: {
      platformUserId: "user-1",
    },
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    command,
    args: [],
    rawText,
    receivedAt: 1000,
  };
}

function buildCallbackEvent(
  actionId: string,
  value: NonNullable<Extract<MessagingInboundEvent, { kind: "callback" }>["value"]>,
  channel: MessagingChannelKind = "telegram",
): Extract<MessagingInboundEvent, { kind: "callback" }> {
  return {
    id: "event-callback",
    kind: "callback",
    actor: {
      platformUserId: "user-1",
    },
    channel: {
      channel,
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    interaction: {
      channel,
      id: actionId,
    },
    actionId,
    value,
    receivedAt: 1000,
  };
}

function buildTextEvent(
  text: string,
  overrides: {
    actorDisplayName?: string;
    conversationTitle?: string;
  } = {},
): Extract<MessagingInboundEvent, { kind: "text" }> {
  return {
    id: "event-text",
    kind: "text",
    actor: {
      platformUserId: "user-1",
      displayName: overrides.actorDisplayName,
    },
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
        title: overrides.conversationTitle,
      },
    },
    receivedAt: 1000,
    text,
  };
}
