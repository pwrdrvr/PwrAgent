import { expect, it } from "vitest";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import { record } from "./scaling-audit-results";

it.each([[1, 1], [7, 1], [7, 2], [7, 4]])(
  "resolves pin demand for %i owners at %i times density", async (owners, density) => {
    const sizes = [68, 29, 3, 2, 2, 1, 1].slice(0, owners).map((size) => size * density);
    const inventory = sizes.map((size, owner) => Array.from({ length: size }, (_, i) => ({
      id: "t" + i, source: "codex", title: "thread-" + i, titleSource: "explicit", linkedDirectories: [],
      inbox: { inInbox: false },
      federation: {
        ref: buildFederatedThreadRef({ backend: "codex", threadId: "t" + i, instanceId: "p" + owner }),
        peerStatus: "connected", instanceLabel: "Peer",
      },
    })));
    const pins = inventory.flat().map((row) => ({
      ref: row.federation.ref, addedAt: 0, instanceLabel: "Peer", summary: row,
    }));
    let requests = 0;
    let servedRows = 0;
    let publications = 0;
    const fetch = async (target) => {
      const threads = inventory[Number(target.instanceId.slice(1))];
      requests++;
      servedRows += threads.length;
      return {
        backend: "all", unchanged: false, fetchedAt: 1, threads: structuredClone(threads), directories: [],
        inboxThreadKeys: [], launchpadDefaults: { backend: "codex", executionMode: "default" },
      };
    };
    const cache = new RemoteThreadSummaryCache({
      peers: () => sizes.map((_, i) => ({
        target: { scope: "remote", instanceId: "p" + i }, label: "Peer", capabilities: ["thread_navigation"],
      })),
      peerStatus: () => ({ status: "connected" }),
      fetchSnapshot: fetch, fetchPinnedSnapshot: fetch, fetchArchivedThreads: async () => [],
      hasNavigationSubscription: () => true, onPinnedSummariesRefreshed: () => { publications++; },
    });
    const settle = async () => {
      for (let i = 0; i < 120; i++) await Promise.resolve();
    };
    const check = async () => {
      const result = await cache.resolvePinnedThreads(pins);
      const identities = result.threads.map((row) => row.federation.ref.target.instanceId + ":" + row.id);
      expect(new Set(identities).size).toBe(pins.length);
    };
    const mark = (phase) => {
      record({ kind: "pins", owners, density, phase, requests, servedRows, publications });
      requests = servedRows = publications = 0;
    };
    try {
      await cache.resolvePinnedThreads(pins);
      await settle();
      await check();
      mark("cold");
      for (let i = 0; i < 8; i++) await check();
      await settle();
      mark("8-warm");
      for (let i = 0; i < 8; i++) {
        inventory[0][0].title = "changed-" + i;
        cache.invalidate("p0");
        await settle();
        await check();
      }
      mark("8-invalidate");
    } finally {
      cache.dispose();
    }
  },
);
