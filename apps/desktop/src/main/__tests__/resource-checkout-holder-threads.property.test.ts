import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ResourceHolder, ResourceThreadRef } from "@pwragent/shared/contracts/resource-checkouts";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import { actorHolder, resourceThreadShowRequest } from "../resource-checkouts/checkout-projection";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";

/**
 * Rule: every thread that holds or waits for a resource is named by its own
 * title, and clicking it shows that thread on the instance that owns it.
 *
 * Two profiles share this machine's CPU pool, as every profile on a root
 * does. Threads on either profile take slots or queue for them, and later
 * their owner renames them. The oracle is the owning profile's title map:
 *
 * - every holder names its owning profile;
 * - the owner reads its own threads by their current title and opens them in
 *   place;
 * - the other profile cannot look the thread up, so it reads the title the
 *   thread had when it asked, and opens it through its owner.
 *
 * Before the fix every holder read "Agent thread", whoever it was.
 */

const MACHINE = "host";
const PROFILES = ["default", "dev"] as const;
type Profile = (typeof PROFILES)[number];

type Ask = { owner: Profile; units: number; title: string; renamed: string };

const titleArb = fc.string({ minLength: 1, maxLength: 24 }).filter((title) => title.trim() === title && title.length > 0);
const askArb: fc.Arbitrary<Ask> = fc.record({
  owner: fc.constantFrom(...PROFILES),
  units: fc.integer({ min: 1, max: 2 }),
  title: titleArb,
  renamed: titleArb,
});

function threadOf(holder: ResourceHolder): ResourceThreadRef {
  if (holder.kind !== "thread") throw new Error(`Expected a thread holder, got ${holder.kind}.`);
  return holder.thread;
}

describe("resource checkout holders", () => {
  it("names each holder and waiter by its owner's title and opens it on its owner", async () => {
    await fc.assert(fc.asyncProperty(fc.array(askArb, { minLength: 1, maxLength: 6 }), async (asks) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-holder-threads-"));
      // Each profile knows only its own threads' titles, as the backend
      // registry does. `renamed` flips them to the later title.
      const titles = new Map<string, string>();
      const services = Object.fromEntries(PROFILES.map((profile) => [profile, new DesktopResourceCheckoutService({
        viewer: { instanceId: profile, instanceLabel: "Studio", profile, machineId: MACHINE },
        machineStore: openResourceCheckoutStore(path.join(root, "machine.db"), MACHINE), machineCpuCount: 3,
        bindings: [], now: () => 10, requestPeer: async () => { throw new Error("Offline"); }, warn: () => {},
        threadTitle: (thread) => thread.instanceId === undefined || thread.instanceId === profile
          ? titles.get(`${profile}:${thread.threadId}`)
          : undefined,
      })])) as Record<Profile, DesktopResourceCheckoutService>;
      try {
        const resourceId = services.default.read().resources[0]!.resourceId;
        for (const [index, ask] of asks.entries()) {
          const threadId = `thread-${index}`;
          titles.set(`${ask.owner}:${threadId}`, ask.title);
          const service = services[ask.owner];
          const outcome = await service.perform({
            kind: "request", idempotencyKey: `ask-${index}`, resourceId, purpose: `ask-${index}`,
            expectedDurationMs: 1_000, units: ask.units,
          }, service.threadActor("codex", threadId));
          expect(["granted", "queued"]).toContain(outcome.outcome);
        }

        const check = (renamed: boolean) => {
          for (const viewer of PROFILES) {
            const resource = services[viewer].read().resources.find((candidate) => candidate.resourceId === resourceId)!;
            const named = [
              ...resource.allocations.map((allocation) => ({ purpose: allocation.taskLabel, thread: threadOf(allocation.holder) })),
              ...resource.queue.map((entry) => ({ purpose: entry.purpose, thread: threadOf(entry.requester) })),
            ];
            expect(named).toHaveLength(asks.length);
            for (const { purpose, thread } of named) {
              const index = Number(purpose.slice("ask-".length));
              const ask = asks[index]!;
              expect(thread.threadId).toBe(`thread-${index}`);
              const own = ask.owner === viewer;
              expect({ viewer, purpose, title: thread.title }).toEqual({
                viewer, purpose, title: own && renamed ? ask.renamed : ask.title,
              });
              expect(thread.instanceId).toBe(ask.owner);
              expect(resourceThreadShowRequest(thread, viewer)).toEqual({
                backend: "codex", threadId: `thread-${index}`,
                ...(own ? {} : { federationTarget: { scope: "remote", instanceId: ask.owner } }),
              });
            }
          }
        };
        check(false);
        for (const [index, ask] of asks.entries()) titles.set(`${ask.owner}:thread-${index}`, ask.renamed);
        check(true);
      } finally {
        await Promise.all(PROFILES.map((profile) => services[profile].close()));
        rmSync(root, { recursive: true, force: true });
      }
    }), { numRuns: 25 });
  });

  it("opens a stored holder from before owners were recorded on the owner its key names", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-holder-legacy-"));
    const services = PROFILES.map((profile) => new DesktopResourceCheckoutService({
      viewer: { instanceId: profile, instanceLabel: "Studio", profile, machineId: MACHINE },
      machineStore: openResourceCheckoutStore(path.join(root, "machine.db"), MACHINE), machineCpuCount: 2,
      bindings: [], now: () => 10, requestPeer: async () => { throw new Error("Offline"); }, warn: () => {},
    }));
    const [owner, viewer] = services as [DesktopResourceCheckoutService, DesktopResourceCheckoutService];
    try {
      const resourceId = owner.read().resources[0]!.resourceId;
      // The actor every release before this one stored: no owner, no title.
      const legacy = { key: JSON.stringify(["default", "codex", "old"]), manage: false,
        holder: { kind: "thread" as const, thread: { backend: "codex" as const, threadId: "old", title: "Agent thread" } } };
      await owner.perform({ kind: "request", idempotencyKey: "old", resourceId, purpose: "old", expectedDurationMs: 1_000, units: 1 }, legacy);
      const held = threadOf(viewer.read().resources[0]!.allocations[0]!.holder);
      expect(resourceThreadShowRequest(held, "dev")).toEqual({
        backend: "codex", threadId: "old", federationTarget: { scope: "remote", instanceId: "default" },
      });
      expect(resourceThreadShowRequest(threadOf(owner.read().resources[0]!.allocations[0]!.holder), "default")).toEqual({
        backend: "codex", threadId: "old",
      });
    } finally {
      await Promise.all(services.map((service) => service.close()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Rule: only a stored key's leading array element names the owner.
  it.each([JSON.stringify("abc"), JSON.stringify({ owner: "x" }), JSON.stringify([7, "codex", "t"]), "not json"])(
    "names no owner for a key without one: %s", (key) => {
      const holder = actorHolder({ key, manage: false, holder: { kind: "thread", thread: { backend: "codex", threadId: "t", title: "T" } } });
      expect(holder).toEqual({ kind: "thread", thread: { backend: "codex", threadId: "t", title: "T" } });
    },
  );

  it.each([
    undefined, null, "thread", {}, { backend: "codex" }, { backend: "nope", threadId: "t" },
    { backend: "codex", threadId: "  " }, { backend: "codex", threadId: "t", instanceId: 7 },
  ])("shows nothing for a malformed holder reference %j", (thread) => {
    expect(resourceThreadShowRequest(thread, "default")).toBeUndefined();
  });
});
