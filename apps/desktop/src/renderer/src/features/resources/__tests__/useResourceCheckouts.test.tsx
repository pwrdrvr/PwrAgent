import fc from "fast-check";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResourceCheckoutActionRequest,
  ResourceCheckoutActionResult,
  ResourceCheckoutsChangedEvent,
  ResourceCheckoutsSnapshot,
} from "@pwragent/shared/contracts/resource-checkouts";
import type { ResourceCheckoutsSource } from "../resource-checkouts-source";
import { useResourceCheckouts } from "../useResourceCheckouts";

afterEach(() => {
  cleanup();
});

const snapshotAt = (revision: number): ResourceCheckoutsSnapshot => ({
  contractVersion: 1,
  revision,
  observedAt: revision,
  viewer: { instanceId: "i", instanceLabel: "host", profile: "default" },
  authorities: [],
  resources: [],
  registerGate: { allowed: true },
  agentTools: "enabled",
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function controlledSource() {
  const reads: Array<Deferred<ResourceCheckoutsSnapshot>> = [];
  const performs: Array<Deferred<ResourceCheckoutActionResult>> = [];
  let emit: ((event: ResourceCheckoutsChangedEvent) => void) | undefined;
  const source: ResourceCheckoutsSource = {
    origin: "live",
    read: () => {
      const next = deferred<ResourceCheckoutsSnapshot>();
      reads.push(next);
      return next.promise;
    },
    subscribe(onChanged) {
      emit = onChanged;
      return () => undefined;
    },
    perform: vi.fn((_request: ResourceCheckoutActionRequest) => {
      const next = deferred<ResourceCheckoutActionResult>();
      performs.push(next);
      return next.promise;
    }),
  };
  return { source, reads, performs, emit: (revision: number) => emit!({ revision }) };
}

const extend = (resourceId: string, key: string): ResourceCheckoutActionRequest => ({
  kind: "extend",
  idempotencyKey: key,
  resourceId,
  allocationId: `alloc-${resourceId}`,
  generation: 1,
});

describe("useResourceCheckouts", () => {
  it("keeps a newer snapshot on screen when an older read fails late", async () => {
    const { source, reads, emit } = controlledSource();
    const { result } = renderHook(() => useResourceCheckouts(source));
    await act(async () => emit(3));
    expect(reads).toHaveLength(2);
    await act(async () => reads[1]!.resolve(snapshotAt(3)));
    await act(async () => reads[0]!.reject(new Error("socket closed")));
    expect(result.current.view).toEqual({ status: "ready", snapshot: snapshotAt(3) });
  });

  it("still reports a failure when no later read has succeeded", async () => {
    const { source, reads } = controlledSource();
    const { result } = renderHook(() => useResourceCheckouts(source));
    await act(async () => reads[0]!.reject(new Error("socket closed")));
    expect(result.current.view).toMatchObject({ status: "error", message: "socket closed" });
  });

  it("keeps an action pending exactly until its own result settles", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 2, max: 4 }).chain((count) => fc.tuple(
        fc.constant(count),
        fc.shuffledSubarray([...Array(count).keys()], { minLength: count, maxLength: count }),
      )),
      async ([count, settleOrder]) => {
        const { source, performs } = controlledSource();
        const { result, unmount } = renderHook(() => useResourceCheckouts(source));
        const requests = [...Array(count).keys()].map((index) => extend(`res-${index}`, `k${index}`));
        await act(async () => {
          for (const request of requests) void result.current.perform(request);
        });
        const open = new Set(requests.keys());
        for (const index of settleOrder) {
          await act(async () => performs[index]!.resolve({ outcome: "accepted" }));
          open.delete(index);
          expect(result.current.pending.map(({ request }) => request))
            .toEqual(requests.filter((_request, candidate) => open.has(candidate)));
        }
        unmount();
      },
    ), { numRuns: 30 });
  });

  it("does not report a failure through settled when the caller shows it", async () => {
    const { source, performs } = controlledSource();
    const { result } = renderHook(() => useResourceCheckouts(source));
    await act(async () => {
      void result.current.perform(extend("res-a", "k1"), { reportFailure: false });
    });
    await act(async () => performs[0]!.resolve({ outcome: "unknown", message: "timed out" }));
    expect(result.current.settled).toBeNull();
    await act(async () => {
      void result.current.perform(extend("res-a", "k2"), { reportFailure: false });
    });
    await act(async () => performs[1]!.resolve({ outcome: "accepted" }));
    expect(result.current.settled?.result.outcome).toBe("accepted");
  });
});
