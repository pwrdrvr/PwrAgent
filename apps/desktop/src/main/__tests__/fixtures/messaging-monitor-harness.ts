import { setImmediate } from "node:timers/promises";
import { vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { MessagingDeliveryResult, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "../../messaging/core/messaging-adapter";
import { NavigationQueryStore } from "../../app-server/navigation-query-store";
import { messagingInboundHarness } from "./messaging-inbound-harness";

export async function messagingMonitorHarness(options: { channel?: "telegram" | "discord"; edits?: boolean; clock?: () => number } = {}) {
  const f = await messagingInboundHarness({ ...options, shared: true, route: "unbound" });
  const rows: NavigationThreadSummary[] = Array.from({ length: 12 }, (_, index) => ({
    id: `monitor-thread-${index}`, source: index % 2 ? "claude" : "codex", title: `Fixture row ${index}`, titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 10_000 - index,
    ...(index < 3 ? { pinnedRank: String(index + 1) } : {}),
  }));
  const query = new NavigationQueryStore();
  const reads: Array<{ kind: string; threadId?: string; countsAsActivity?: boolean; size?: number; pinned?: string }> = [];
  const hooks: { deliver?: (intent: MessagingSurfaceIntent) => Promise<void>; failure?: "transient" | "permanent"; failQuery?: boolean } = {};
  const delivered: MessagingSurfaceIntent[] = [];
  let sequence = 0;
  const backend: MessagingBackendBridge = {
    ...f.backend,
    getNavigationQueryPage: async function (request) {
      if (this !== backend) throw new Error("Monitor query receiver lost");
      reads.push({ kind: "query", size: request.pageSize,
        pinned: request.query.kind === "star-map" ? request.query.filters?.pinned : undefined });
      if (hooks.failQuery) throw new Error("Fixture query failure");
      return await query.readPage({ request, scopeKey: "monitor-fixture", loadIndex: async () => ({ threads: rows, directories: [] }) });
    },
    getNavigationSelectedDetail: async request => ({ protocol: 2, revision: "fixture", ref: request.ref,
      identity: "present", readiness: "ready", thread: rows.find(row => row.id === request.ref.threadId) }),
    readThreadStatus: async request => { reads.push({ kind: "status", threadId: request.threadId, countsAsActivity: request.countsAsActivity }); return "idle"; },
    readThreadLastAssistantMessage: async request => { reads.push({ kind: "snippet", threadId: request.threadId, countsAsActivity: request.countsAsActivity }); return `Fixture reply ${request.threadId}`; },
  };
  f.controllerOptions.backend = backend;
  const profile = f.controllerOptions.adapter.capabilityProfile;
  Object.assign(profile, { text: { ...profile.text, supportsMessageEdit: options.edits ?? true } });
  f.controllerOptions.adapter.deliver = async intent => {
    await hooks.deliver?.(intent);
    delivered.push(intent);
    const monitor = intent.kind === "status" && intent.text.startsWith("Monitor:");
    return { outcome: monitor && hooks.failure ? "failed" : "presented", channel: f.channel.channel, deliveredAt: 1_000,
      ...(monitor && hooks.failure ? { errorMessage: hooks.failure === "permanent" ? "Unknown Channel" : "Fixture transient failure" } : {
        surface: { id: `monitor-surface-${++sequence}`, channel: f.channel.channel },
      }),
    } satisfies MessagingDeliveryResult;
  };
  // Keep native timer handles and cancellation. The driver merely fires a
  // captured callback early; no clock sleeps, fake timers or serialized lanes.
  const timers = new Map<ReturnType<typeof setTimeout>, { run: () => void; delay: number }>();
  const nativeSet = globalThis.setTimeout;
  const nativeClear = globalThis.clearTimeout;
  const set = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
    let timer: ReturnType<typeof setTimeout>;
    const run = () => { timers.delete(timer); handler(...args); };
    timer = nativeSet(run, delay);
    if ([10_000, 30_000, 60_000, 300_000].includes(delay ?? 0)) timers.set(timer, { run, delay: delay! });
    return timer;
  });
  const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(timer => {
    if (timer && typeof timer === "object") timers.delete(timer);
    nativeClear(timer);
  });
  const subscription = () => f.store.findActiveMonitorSubscriptionForChannel(f.channel);
  const command = (args: string[] = []) => f.controller.handleInboundEvent({ ...f.event(), kind: "command", command: "monitor", args, rawText: `/monitor ${args.join(" ")}` });
  const tick = async () => {
    const current = [...timers.entries()];
    for (const [timer, value] of current) { nativeClear(timer); value.run(); }
    await setImmediate();
  };
  return { ...f, backend, rows, reads, delivered, hooks, timers, subscription, command, tick,
    close: async () => {
      try { await f.close(); }
      finally { for (const timer of timers.keys()) nativeClear(timer); timers.clear(); set.mockRestore(); clear.mockRestore(); }
    },
  };
}
