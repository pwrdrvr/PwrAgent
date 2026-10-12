import { expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest, NavigationRow, NavigationThreadSummary } from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";
import {
  materializeOwnerResolvedNavigation,
  OwnerResolvedRowMemory,
} from "../app-server/navigation-owner-resolved-query";

const local: NavigationThreadSummary = { id: "local", source: "codex", title: "Local", titleSource: "explicit",
  linkedDirectories: [], inbox: { inInbox: false } };

function peerRow(threadId: string, extra: Partial<NavigationRow> = {}): NavigationRow {
  return { ref: { backend: "codex", threadId, ownerInstanceId: "peer" }, rowRevision: "owner", id: threadId,
    source: "codex", title: `Peer ${threadId}`, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId, instanceId: "peer" }), instanceLabel: "Peer",
      peerStatus: "connected" },
    ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown", ...extra };
}

function ownerPage(rows: NavigationRow[]): NavigationQueryPage {
  return { protocol: 2, queryKey: "owner", generation: "g", ownerEpoch: "e", countsRevision: "r",
    coverage: { state: "complete" }, counts: { total: rows.length, active: 0, unread: 0, review: 0 }, complete: true,
    entries: rows.map((row, index) => ({ row, orderKey: String(index), placement: { kind: "root" } })) };
}

const request = (identities: NavigationRow["ref"][]): NavigationQueryRequest => ({ protocol: 2, consumer: "main-sidebar",
  inventory: "viewer", query: { kind: "exact", identities, includeAncestry: true, resolveFromOwners: true } });

it("serves this machine's rows when a connected owner stops answering within its budget", async () => {
  const parent = peerRow("parent");
  const child = peerRow("child", { parentThreadId: "parent", parentThreadBackend: "codex" });
  const memory = new OwnerResolvedRowMemory();
  const signals: AbortSignal[] = [];
  const readOwnerPage = vi.fn(async (_target: unknown, _request: unknown, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    return ownerPage([parent, child]);
  });
  const read = (budget?: number) => materializeOwnerResolvedNavigation({
    request: request([{ backend: "codex", threadId: "local" }, child.ref]),
    loadViewerIndex: async () => ({ threads: [local], directories: [] }),
    readOwnerPage, cachedOwnerThreads: () => [], memory, ownerReadBudgetMs: budget,
  });
  expect((await read()).entries.map(({ row }) => row.id)).toEqual(["local", "parent", "child"]);
  // An owner that ignores cancellation still cannot hold the page past its budget.
  readOwnerPage.mockImplementationOnce((_target, _request, options) => {
    signals.push(options.signal);
    return new Promise<never>(() => undefined);
  });
  const started = Date.now();
  const held = await read(20);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(held.entries.map(({ row }) => [row.id, row.federation?.peerStatus])).toEqual([
    ["local", undefined], ["parent", "degraded"], ["child", "degraded"]]);
  expect(held.entries[2]!.placement).toEqual({ kind: "child", parent: parent.ref });
  expect(signals.map((signal) => signal.aborted)).toEqual([false, true]);
});

it("forgets a held row once its owner answers without it", async () => {
  const row = peerRow("archived");
  const memory = new OwnerResolvedRowMemory();
  const readOwnerPage = vi.fn(async () => ownerPage([row]));
  const read = () => materializeOwnerResolvedNavigation({ request: request([row.ref]),
    loadViewerIndex: async () => ({ threads: [], directories: [] }), readOwnerPage, cachedOwnerThreads: () => [], memory });
  expect((await read()).entries.map(({ row: entry }) => entry.id)).toEqual(["archived"]);
  readOwnerPage.mockRejectedValueOnce(new Error("owner failed"));
  expect((await read()).entries.map(({ row: entry }) => entry.id)).toEqual(["archived"]);
  // The owner no longer has it, so a later outage must not resurrect it.
  readOwnerPage.mockResolvedValueOnce(ownerPage([]));
  expect((await read()).entries).toEqual([]);
  readOwnerPage.mockRejectedValueOnce(new Error("owner failed"));
  expect((await read()).entries).toEqual([]);
});
