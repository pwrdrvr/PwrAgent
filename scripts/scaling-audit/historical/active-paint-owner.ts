// Staged only in the disposable native benchmark build.
import { createHash, randomUUID } from "node:crypto";
import type { AppServerNotification } from "@pwragent/shared/contracts/normalized-app-server";
import type { SubmitDurableTurnRequest } from "@pwragent/shared/contracts/durable-turn-requests";
import { canonicalDurableTurnRequest } from "@pwragent/shared/durable-turn-request";
import { claudeReviewOutput } from "../claude/claude-review-findings";
import { getReviewAutoFixArming } from "../thread-reviews/review-auto-fix";
import { getThreadReviewService } from "../thread-reviews/thread-review-runtime";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { FederationRouter } from "../federation/federation-router";
import {
  additionalFederationBackendCapabilities,
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  registerFederationBackendHandlers,
} from "../federation/federation-backend-bridge";

const now = () => performance.timeOrigin + performance.now();
const input = [{ type: "text" as const, text: "Synthetic durable retry" }];
const ref = (threadId: string) => ({ backend: "codex" as const, threadId });
const grants = ["turn_control", "durable_turn_requests_v1"] as const;
type Lane = "status" | "review" | "inbound" | "outbound";
export type Cadence = Record<Lane, number>;
type Trace = {
  queries: Array<{ kind: string; start: number; end: number }>;
  events: Array<{ method: string; at: number; threadId?: string; pricingRows?: number }>;
  deliveries: Array<{ lane: Lane; due: number; start: number; end: number }>;
};
export type CompletedTrace = Trace & {
  stoppedAt: number;
  countedReviews: number;
  readReviewCalls: number;
  forbiddenFixes: number;
};
type Prepare = {
  cadence: Cadence;
  heldThreads: string[];
  statusThreads: string[];
  turnThread: string;
  federationThreads: [string, string];
  queueDepth: number;
  redeliveries: number;
};
type ActivePaintDriver = {
  prepare(options: Prepare): Promise<{ heldThreads: number; forbiddenFixes: number }>;
  start(cadence: Cadence): { startedAt: number; startReviews: number };
  stop(): Promise<CompletedTrace>;
};
declare global {
  var __activePaint: ActivePaintDriver | undefined;
  var __auditReplayNotification: ((notification: AppServerNotification) => Promise<void>) | undefined;
}

let active: Trace | undefined;
const holdChecks = new Set<string>();

async function timeAuditQuery<T>(kind: string, query: () => Promise<T>): Promise<T> {
  const phase = active;
  if (!phase) return query();
  const start = now();
  try { return await query(); }
  finally { phase.queries.push({ kind, start, end: now() }); }
}

export async function auditStackHold(review: { threadId: string }, read: () => Promise<string | undefined>) {
  if (process.env.AUDIT_ACTIVE_PAINT === "1" && review.threadId.startsWith("t-")) {
    holdChecks.add(review.threadId);
    return "Synthetic stack wait";
  }
  return read();
}

function loopbackOwner(id: string, peerId: string, send: (envelope: unknown) => void) {
  const runtime = new DesktopFederationRuntime();
  // Replace transport discovery only. Both endpoints still use the production
  // sender, router, capability check, SQLite receipt service and owner queue.
  const router = new FederationRouter({
    localInstanceId: id,
    methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    additionalRequiredCapabilities: additionalFederationBackendCapabilities,
  });
  Object.assign(runtime, {
    router,
    localInstanceId: id,
    visiblePeers: () => [{ id: peerId, label: peerId, status: "connected", role: "client", capabilities: grants }],
  });
  const internals = runtime as unknown as {
    durableTurnRequestService(): Parameters<typeof registerFederationBackendHandlers>[0]["durableTurnRequests"];
    receiveEnvelope(envelope: unknown, peer: string): Promise<void>;
  };
  registerFederationBackendHandlers({ router, backend: runtime.localBackend(), durableTurnRequests: internals.durableTurnRequestService() });
  router.registerConnection({ peerId, capabilities: [...grants], sendEnvelope: send });
  return {
    send: (request: SubmitDurableTurnRequest) => runtime.submitDurableTurnRequest("synthetic-device", request, { scope: "remote", instanceId: peerId }),
    receive: (envelope: unknown) => internals.receiveEnvelope(envelope, peerId),
  };
}

type OwnerServices = Awaited<ReturnType<typeof import("../owner-services").startOwnerServices>>;
type Queue = import("@pwragent/owner-core/thread-turn-queue").ThreadTurnQueue;

export function installActivePaintAudit({ registry, service }: OwnerServices) {
  if (process.env.AUDIT_ACTIVE_PAINT !== "1") return;
  const emit = (notification: AppServerNotification) => globalThis.__auditReplayNotification!(notification);
  const queue = (registry as unknown as { threadTurnQueue: Queue }).threadTurnQueue;
  const navigation = service as unknown as {
    readNavigationQueryPageOnce(request: { query: { kind: string } }, options?: unknown): Promise<unknown>;
  };
  const readNavigation = navigation.readNavigationQueryPageOnce.bind(navigation);
  navigation.readNavigationQueryPageOnce = (request, options) =>
    timeAuditQuery("navigation:" + request.query.kind, () => readNavigation(request, options));
  const readThread = registry.readThread.bind(registry);
  registry.readThread = (request) => timeAuditQuery("thread:" + request.threadId, () => readThread(request));
  let forbiddenFixes = 0;
  let countedReviews = 0;
  let readReviewCalls = 0;
  const reviews = getThreadReviewService();
  const readReview = reviews.get.bind(reviews);
  reviews.get = (...args) => {
    if (active) readReviewCalls++;
    return readReview(...args);
  };
  registry.submitTurnIfIdle = new Proxy(registry.submitTurnIfIdle, {
    apply(submit, receiver, args) {
      if (args[0].messageOrigin?.reviewAutoFix) forbiddenFixes++;
      return Reflect.apply(submit, receiver, args);
    },
  });
  registry.onEvent(({ notification }) => {
    if (!active) return;
    const threadId = "threadId" in notification.params && typeof notification.params.threadId === "string"
      ? notification.params.threadId : undefined;
    const pricing = notification.method === "thread/pricing/updated"
      ? (notification.params as { pricing?: { lines?: unknown[] } }).pricing : undefined;
    active.events.push({
      at: now(), method: notification.method, threadId,
      ...(Array.isArray(pricing?.lines) ? { pricingRows: pricing.lines.length } : {}),
    });
  });

  const federation: Partial<Record<"inbound" | "outbound", () => Promise<void>>> = {};
  const verifyQueues: Array<() => boolean> = [];
  let timers: ReturnType<typeof setTimeout>[] = [];
  let failures: string[] = [];
  const inFlight = new Set<Promise<void>>();
  let reviewing = 0;
  let status = 0;
  const review = async (threadId: string, findings: boolean, armAutoFix = findings) => {
    const turnId = `audit-turn-${++reviewing}`;
    if (armAutoFix) getReviewAutoFixArming().starting(ref(threadId), "auto-fix").accepted(turnId);
    await emit({ method: "turn/started", params: { threadId, turnId, turn: { id: turnId, status: "inProgress", model: "gpt-5.2" } } });
    const tokens = { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 20, totalTokens: 1020 };
    await emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last: tokens, total: tokens } } });
    if (findings) {
      await emit({ method: "item/completed", params: { threadId, turnId, item: {
        id: `audit-findings-${turnId}`, type: "exitedReviewMode", review: "",
        data: { reviewOutput: claudeReviewOutput({ findings: [{
          file: "src/synthetic.ts", line: 1, summary: "Synthetic finding", failureScenario: "Synthetic failure",
        }] }, "/fixture") },
      } } });
      countedReviews++;
    }
    await emit({ method: "turn/completed", params: { threadId, turnId, turn: { id: turnId, status: "completed", output: [] } } });
  };

  let work: Record<Lane, () => Promise<void>>;
  globalThis.__activePaint = {
    async prepare({ cadence, heldThreads, statusThreads, turnThread, federationThreads, queueDepth, redeliveries }) {
      // Preload held Auto-fixes with real review events. Unrelated metered turn
      // completions wake that live dispatcher during measurement.
      for (const threadId of heldThreads) await review(threadId, true);
      const deadline = now() + 20000;
      while (holdChecks.size < heldThreads.length && now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (holdChecks.size !== heldThreads.length || forbiddenFixes !== 0) {
        throw new Error(`Expected ${heldThreads.length} held review threads, got ${holdChecks.size} with ${forbiddenFixes} dispatches`);
      }
      if (cadence.inbound || cadence.outbound) {
        const ids = ["synthetic-viewer", "synthetic-peer"] as const;
        const transportErrors: unknown[] = [];
        const catchTransportError = (error: unknown) => { transportErrors.push(error); };
        const local = loopbackOwner(ids[0], ids[1], envelope => { void remote.receive(envelope).catch(catchTransportError); });
        const remote = loopbackOwner(ids[1], ids[0], envelope => { void local.receive(envelope).catch(catchTransportError); });
        for (const [index, lane] of (["inbound", "outbound"] as const).entries()) {
          if (!cadence[lane]) continue;
          const target = ref(federationThreads[index]);
          // Never resume the synthetic queues. The app owns them until exit.
          queue.suspendDispatch(target);
          queue.restoreQueued(Array.from({ length: queueDepth - 1 }, (_, slot) => ({
            ...target, id: `audit-neighbor-${lane}-${slot}`, createdAt: slot, origin: "manual" as const, input,
          })));
          const request: SubmitDurableTurnRequest = {
            clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
            request: { ...target, input },
          };
          request.clientRequest.payloadHash = createHash("sha256")
            .update(canonicalDurableTurnRequest(ids[index], request)).digest("hex");
          const sender = index === 0 ? remote : local;
          const accepted = await sender.send(request);
          if (accepted.ownerInstanceId !== ids[index] || accepted.result?.queueStatus !== "queued"
            || queue.getQueuedEntries(target).length !== queueDepth) {
            throw new Error(`Expected one ${lane} receipt on its owner and a held FIFO of ${queueDepth}: ${JSON.stringify(accepted)}`);
          }
          const original = JSON.stringify(accepted);
          verifyQueues.push(() => queue.getQueuedEntries(target).length === queueDepth);
          federation[lane] = async () => {
            if (transportErrors.length) throw transportErrors[0];
            const receipts = await Promise.all(Array.from({ length: redeliveries }, () => sender.send(request)));
            if (receipts.some(receipt => JSON.stringify(receipt) !== original)) {
              throw new Error(`Federation ${lane} changed the original receipt`);
            }
          };
        }
      }
      const reviewThreads = heldThreads.length ? heldThreads : [turnThread];
      work = {
        status: async () => {
          const index = status++;
          const threadId = statusThreads[index % statusThreads.length];
          await emit({ method: "thread/status/changed", params: {
            threadId, status: { type: Math.floor(index / statusThreads.length) % 2 ? "idle" : "active" },
          } });
        },
        // Cycle one fixed ledger, with interleaved completed, armed reviews
        // on the held cohort rather than reviews on the visible thread.
        review: () => reviewing % 4 === 0
          ? review(reviewThreads[Math.floor(reviewing / 4) % reviewThreads.length], true, heldThreads.length > 0)
          : review(turnThread, false),
        inbound: () => federation.inbound!(),
        outbound: () => federation.outbound!(),
      };
      return { heldThreads: holdChecks.size, forbiddenFixes };
    },
    start(cadence) {
      if (active) throw new Error("Measurement already running");
      const phase: Trace = { queries: [], events: [], deliveries: [] };
      active = phase;
      failures = [];
      const startedAt = now();
      const startReviews = countedReviews;
      readReviewCalls = 0;
      for (const [lane, interval] of Object.entries(cadence) as Array<[Lane, number]>) {
        if (!interval) continue;
        const slot = timers.length;
        const schedule = (due: number) => {
          timers[slot] = setTimeout(() => {
            const start = now();
            const task = work[lane]().catch(error => { failures.push(String(error)); }).finally(() => {
              phase.deliveries.push({ lane, due, start, end: now() });
              inFlight.delete(task);
              if (active === phase) schedule(due + interval);
            });
            inFlight.add(task);
          }, Math.max(0, due - now()));
        };
        schedule(startedAt + interval / 2);
      }
      return { startedAt, startReviews };
    },
    async stop() {
      const phase = active;
      const stoppedAt = now();
      active = undefined;
      timers.forEach(timer => clearTimeout(timer));
      timers = [];
      await Promise.all(inFlight);
      if (!verifyQueues.every(verify => verify())) failures.push("Federation redelivery changed a held FIFO");
      if (!phase || failures.length || forbiddenFixes) throw new Error(`Audit failed: ${failures.join(", ")}; Auto-fix dispatches: ${forbiddenFixes}`);
      return { ...phase, stoppedAt, countedReviews, readReviewCalls, forbiddenFixes };
    },
  };
}
