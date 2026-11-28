import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import {
  agentNoticeIds,
  type AgentNotificationsSnapshot,
  type ManageAgentNotificationsRequest,
  type ManageAgentNotificationsResponse,
  type NotifyOperatorToolResult,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import { MemoryScheduledThreadActionPayloadStore } from "@pwragent/sqlite-storage/scheduled-thread-action-payload-store";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import {
  FEDERATION_AGENT_NOTIFICATION_METHODS,
  registerFederationAgentNotificationHandlers,
} from "../federation/federation-agent-notifications";
import type { FederationRouter } from "../federation/federation-router";
import { AgentNotificationCenter } from "../scheduled-actions/agent-notification-center";
import { manageLocalAgentNotifications } from "../scheduled-actions/agent-notification-operations";
import { buildAgentNotificationToolHandler } from "../scheduled-actions/agent-notification-tool";
import { FederatedAgentNotifications } from "../scheduled-actions/federated-agent-notifications";
import {
  ScheduledThreadActionService,
  schedulerOwnerId,
} from "../scheduled-actions/scheduled-thread-action-service";
import type { StateDb } from "../state/state-db";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/**
 * A peer's notices, across the real layers: the owner's scheduler, store and
 * notification center answer through the real federation handlers, and the
 * viewer's FederatedAgentNotifications keeps its copy. The transport is an
 * fc.scheduler that releases replies and owner events in a generated order.
 * Requests reach the owner in the order they were sent, as on the one
 * connection a viewer holds to its peer; the owner's replies need not.
 *
 * Promises, checked once everything in flight has landed:
 * - the viewer's copy of the owner's notices equals the owner's own snapshot;
 * - no notice is announced twice on the viewer;
 * - the viewer's banners still showing are exactly the owner's unread
 *   notices that arrived after the viewer connected;
 * - a notice leaves unread only through a dismissal that could see it: one
 *   naming it, a dismiss-all over a list that showed it, or a restart.
 */

const MINUTE = 60_000;
const THREAD = { backend: "codex" as const, threadId: "thread-peer-notice" };
const PEER: FederationRemoteTarget = { scope: "remote", instanceId: "peer-owner" };
const LEASE_MS = 30_000;

/** The owner process: its scheduler, store and notification center over one database. */
class Owner {
  clock = 1_800_000_000_000;
  service!: ScheduledThreadActionService;
  center!: AgentNotificationCenter;
  private generation = 0;
  private readonly payloads = new MemoryScheduledThreadActionPayloadStore();
  private readonly handlers = new Map<string, (envelope: { params?: unknown }) => unknown>();
  private tool!: ReturnType<typeof buildAgentNotificationToolHandler>;

  constructor(private readonly db: StateDb, private readonly publish: () => void) {}

  start(): void {
    const generation = ++this.generation;
    const processId = 9_200_000 + generation;
    const instanceId = `peer-owner-${generation}`;
    const registry = {
      onEvent: () => () => undefined,
      onRestartGateChanged: () => () => undefined,
      isRestartGateClosed: () => false,
      publishLocalEvent: async (event: AgentEvent) => {
        if (event.notification.method === "agentNotifications/updated") this.publish();
      },
      markScheduledThreadBorn: async () => undefined,
      markScheduledThreadStartTerminal: async () => undefined,
      submitTurn: async () => { throw new Error("A notice must never start a turn."); },
      submitHeldTurn: async () => { throw new Error("A notice must never start a turn."); },
      cancelQueuedTurn: () => false,
    } as unknown as DesktopBackendRegistry;
    const service: ScheduledThreadActionService = new ScheduledThreadActionService({
      registry,
      store: new ScheduledThreadActionStore(this.db, this.payloads),
      now: () => this.clock,
      ownerId: schedulerOwnerId({ processId, instanceId, startedAt: this.clock }),
      ownerProbes: {
        currentProcessId: processId,
        isProcessAlive: (candidate) => this.generation === generation && candidate === processId,
        isRuntimeIdentityLive: (identity) => this.generation === generation && identity.instanceId === instanceId,
      },
      setTimer: () => ({}) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      setLeaseTimer: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>,
      clearLeaseTimer: () => undefined,
      agentNotificationLimits: () => ({ maxPerThreadPerDay: 0, maxPerProfilePerDay: 0, maxScheduledPerThread: 0 }),
      deliverAgentNotification: (action) => center.deliver(action),
    });
    const center = new AgentNotificationCenter({
      now: () => this.clock,
      listNotices: (request) => service.listAgentNotifications(request),
      nativeNotificationsEnabled: () => false,
      notifyNative: () => undefined,
      clearNative: () => undefined,
      showThread: () => undefined,
      threadLabel: async () => "Release notes draft",
      publishChanged: () => registry.publishLocalEvent({
        backend: THREAD.backend,
        notification: { method: "agentNotifications/updated", params: { threadId: THREAD.threadId } },
      }),
    });
    this.service = service;
    this.center = center;
    this.tool = buildAgentNotificationToolHandler(service, () => this.clock);
    // The owner answers a peer through its real federation handlers.
    this.handlers.clear();
    registerFederationAgentNotificationHandlers(
      { registerHandler: (method: string, handler: (envelope: { params?: unknown }) => unknown) => {
        this.handlers.set(method, handler);
      } } as unknown as FederationRouter,
      (request, options) => manageLocalAgentNotifications(request, options, {
        center: () => this.center,
        service: () => this.service,
      }),
    );
    service.start();
  }

  stop(): void {
    this.service.dispose();
  }

  async restart(): Promise<void> {
    this.stop();
    this.clock += LEASE_MS + 1;
    this.start();
    await this.service.evaluateDueActions();
  }

  async send(delayMinutes: number): Promise<string> {
    const response = await this.tool({
      action: "send",
      title: "Review the changelog",
      body: "The 2.4 changelog draft is ready for a read.",
      ...(delayMinutes > 0 ? { delayMinutes } : {}),
    }, THREAD);
    if (!response.ok) throw new Error(response.error.message);
    return (response.data as { notifications: NotifyOperatorToolResult }).notifications.notification!.notificationId;
  }

  async tick(minutes: number): Promise<void> {
    this.clock += minutes * MINUTE;
    await this.service.evaluateDueActions();
  }

  async answer(request: ManageAgentNotificationsRequest): Promise<ManageAgentNotificationsResponse> {
    const method = request.action === "snapshot"
      ? FEDERATION_AGENT_NOTIFICATION_METHODS.snapshot
      : FEDERATION_AGENT_NOTIFICATION_METHODS.manage;
    return await this.handlers.get(method)!({ params: request }) as ManageAgentNotificationsResponse;
  }
}

type Op =
  | { kind: "send"; delayMinutes: number }
  | { kind: "tick"; minutes: number }
  | { kind: "ownerDismiss"; pick: number }
  | { kind: "ownerDismissAll" }
  | { kind: "viewerDismiss"; pick: number; fromPeerWindow: boolean }
  | { kind: "viewerCancel"; pick: number }
  | { kind: "viewerDismissAll" }
  | { kind: "release"; count: number }
  | { kind: "reconnect" }
  | { kind: "ownerRestart" }
  | { kind: "check" };

const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("send" as const), delayMinutes: fc.constantFrom(0, 0, 5, 30) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("tick" as const), minutes: fc.constantFrom(5, 30) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("ownerDismiss" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ kind: "ownerDismissAll" as const }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("viewerDismiss" as const), pick: fc.nat(), fromPeerWindow: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("viewerCancel" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ kind: "viewerDismissAll" as const }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("release" as const), count: fc.integer({ min: 1, max: 4 }) }) },
  { weight: 1, arbitrary: fc.constant({ kind: "reconnect" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "ownerRestart" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "check" as const }) },
);

const ids = (items: { id: string }[]) => items.map((item) => item.id).sort();

async function yieldLoop(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function replay(scheduler: fc.Scheduler, ops: Op[]): Promise<void> {
  const db = openInMemoryStateDb();
  // The connection the viewer holds; a reconnect starts a new one, and
  // anything in flight on the old one is lost.
  let connection = 0;
  let connected = false;
  const pending: Promise<unknown>[] = [];
  /** Requests on the wire, delivered to the owner first in, first out. */
  const wire: Array<() => void> = [];
  const notified: string[] = [];
  /** What happened, attached to a failure: ids are random, so a seed does not replay a run exactly. */
  const trace: string[] = [];
  const cleared: string[] = [];
  /** What the owner held unread when the viewer last connected: listed, never announced. */
  let baseline = new Set<string>();
  /** Notices some dismissal could see: the only ones allowed to leave unread. */
  const dismissible = new Set<string>();
  /**
   * Notices in the order they were sent. Ids are random, so a pick follows
   * this order rather than a list's, which can break ties by id, and a
   * failing case replays exactly.
   */
  const sentOrder: string[] = [];
  const bySent = <T extends { id: string }>(items: T[]) =>
    [...items].sort((left, right) => sentOrder.indexOf(left.id) - sentOrder.indexOf(right.id));
  let viewer!: FederatedAgentNotifications;

  const owner = new Owner(db, () => {
    if (!connected) return;
    const sent = connection;
    // The owner's event reaches the viewer later, unless the connection drops.
    pending.push(scheduler.schedule(Promise.resolve(), "event").then(() => {
      if (sent !== connection) return;
      viewer.onRemoteEvent({
        backend: THREAD.backend,
        federationTarget: PEER,
        notification: { method: "agentNotifications/updated", params: { threadId: THREAD.threadId } },
      } as AgentEvent);
    }));
  });

  viewer = new FederatedAgentNotifications({
    local: async () => ({ ok: true, snapshot: { unread: [], scheduled: [], earlier: [] } }),
    remote: async (_target, request) => {
      const sent = connection;
      const arrived = new Promise<void>((resolve) => { wire.push(resolve); });
      void scheduler.schedule(Promise.resolve(), `request ${request.action}`).then(() => wire.shift()?.());
      await arrived;
      if (sent !== connection) throw new Error("disconnected");
      // The owner answers when the request arrives.
      const answer = await owner.answer(request);
      await scheduler.schedule(Promise.resolve(), `reply ${request.action}`);
      if (sent !== connection) throw new Error("disconnected");
      return answer;
    },
    peers: () => connected ? [{ target: PEER, label: "Fixture owner" }] : [],
    watch: () => undefined,
    nativeNotificationsEnabled: () => true,
    notifyNative: ({ key }) => { notified.push(key); trace.push(`notify ${key} on connection ${connection}`); },
    clearNative: (key) => { cleared.push(key); trace.push(`clear ${key} on connection ${connection}`); },
    showThread: () => undefined,
    changed: () => undefined,
    warn: () => undefined,
  });

  async function drain(): Promise<void> {
    for (;;) {
      await yieldLoop();
      if (scheduler.count() === 0) break;
      await scheduler.waitOne();
    }
    await Promise.allSettled(pending.splice(0));
    await yieldLoop();
    if (scheduler.count() > 0) await drain();
  }

  async function connect(): Promise<void> {
    connection += 1;
    connected = true;
    viewer.syncPeers();
    // The first read lands before anything else changes.
    await drain();
    baseline = new Set(owner.center.snapshot().unread.map((item) => item.id));
  }

  function disconnect(): void {
    connection += 1;
    connected = false;
    viewer.syncPeers();
  }

  async function check(label: string): Promise<void> {
    await drain();
    const own = owner.center.snapshot();
    const response = await viewer.manage({ action: "snapshot" }, PEER);
    const seen: AgentNotificationsSnapshot = response.ok ? response.snapshot : { unread: [], scheduled: [], earlier: [] };
    expect({ label, unread: ids(seen.unread), scheduled: ids(seen.scheduled), earlier: ids(seen.earlier) })
      .toEqual({ label, unread: ids(own.unread), scheduled: ids(own.scheduled), earlier: ids(own.earlier) });
    expect(new Set(notified).size, `${label}: a notice was announced twice: ${notified.join(", ")}`).toBe(notified.length);
    const showing = notified.filter((key) => !cleared.includes(key)).sort();
    const expected = own.unread
      .filter((item) => !baseline.has(item.id))
      .map((item) => `agent-notification:${PEER.instanceId}:${item.id}`)
      .sort();
    expect({ label, showing }).toEqual({ label, showing: expected });
    const unseen = own.earlier.map((item) => item.id).filter((id) => !dismissible.has(id));
    expect({ label, dismissedUnseen: unseen }).toEqual({ label, dismissedUnseen: [] });
  }

  const seenBy = async (window: FederationRemoteTarget | undefined) => {
    const response = await viewer.manage({ action: "snapshot" }, window);
    return response.ok ? response.snapshot : { unread: [], scheduled: [], earlier: [] };
  };

  try {
    owner.start();
    await connect();
    for (const [step, op] of ops.entries()) {
      const label = `${step}: ${JSON.stringify(op)}`;
      trace.push(`op ${label}`);
      switch (op.kind) {
        case "send":
          sentOrder.push(await owner.send(op.delayMinutes));
          break;
        case "tick":
          await owner.tick(op.minutes);
          break;
        case "ownerDismiss": {
          const unread = bySent(owner.center.snapshot().unread);
          const item = unread[op.pick % Math.max(1, unread.length)];
          if (item) {
            dismissible.add(item.id);
            await owner.center.dismiss(item.id);
          }
          break;
        }
        case "ownerDismissAll":
          // The owner's own window, with a list as fresh as its center.
          for (const item of owner.center.snapshot().unread) dismissible.add(item.id);
          await owner.center.dismissAll(owner.center.snapshot().unread.map((item) => item.id));
          break;
        case "viewerDismiss": {
          const window = op.fromPeerWindow ? PEER : undefined;
          const unread = bySent((await seenBy(window)).unread);
          const item = unread[op.pick % Math.max(1, unread.length)];
          if (item) {
            dismissible.add(item.id);
            pending.push(viewer.manage({ action: "dismiss", id: item.id, federationTarget: item.federationTarget }, window).catch(() => undefined));
          }
          break;
        }
        case "viewerCancel": {
          const scheduled = bySent((await seenBy(undefined)).scheduled);
          const item = scheduled[op.pick % Math.max(1, scheduled.length)];
          if (item) pending.push(viewer.manage({ action: "cancel", id: item.id, federationTarget: item.federationTarget }, undefined).catch(() => undefined));
          break;
        }
        case "viewerDismissAll": {
          // The window dismisses the notices it lists.
          const shown = (await seenBy(undefined)).unread;
          for (const item of shown) dismissible.add(item.id);
          pending.push(viewer.manage({ action: "dismiss_all", ids: agentNoticeIds(shown) }, undefined).catch(() => undefined));
          break;
        }
        case "release":
          for (let i = 0; i < op.count; i++) {
            await yieldLoop();
            if (scheduler.count() === 0) break;
            await scheduler.waitOne();
          }
          break;
        case "reconnect":
          disconnect();
          await drain();
          await connect();
          break;
        case "ownerRestart":
          // A restart clears read state: every unread notice moves to earlier.
          for (const item of owner.center.snapshot().unread) dismissible.add(item.id);
          disconnect();
          await drain();
          await owner.restart();
          await connect();
          break;
        case "check":
          await check(label);
          break;
      }
    }
    await check("final");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nTRACE\n${trace.join("\n")}`);
  } finally {
    owner.stop();
    db.close();
  }
}

describe("a peer's notices across the owner and a connected viewer", () => {
  it("agree once settled, and announce each notice that arrives once", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.array(opArbitrary, { minLength: 1, maxLength: 24, size: "max" }), replay), {
      // A real database per run: five in CI. To search, raise this locally
      // (2,000 runs take about 16 s) and do not commit it; pin what it finds
      // as named tests in federated-agent-notifications.property.test.ts.
      numRuns: 5,
    });
  });
});
