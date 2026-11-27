import { createSource, fixtureStores } from "./scaling-audit-navigation-fixture";
import { expect, it, vi } from "vitest";
import { buildDirectorySummaries } from "@pwragent/shared/directory-navigation";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import * as directoryStore from "../git-info/directory-store";
import { StackReader } from "../stacks/stack-reader";
import { generate } from "./scaling-audit-generate.mjs";
import { record } from "./scaling-audit-results";

const mocks = fixtureStores();
const copies = Number(process.env.AUDIT_COPIES);
const cases = [1, 2, 4].map((factor) => ({ copies: copies * factor }));
const synthetic = [
  [64, 16, 8], [128, 32, 16], [256, 64, 32], [603, 367, 105], [1206, 367, 105],
  [2412, 367, 105], [603, 367, 0], [603, 367, 211], [3057, 367, 105],
].map(([n, projectRows, pins]) => ({ n, projectRows, pins }));

function uniformThreads({ n, projectRows, pins }) {
  return Array.from({ length: n }, (_, i) => {
    const directory = i < projectRows ? "/fixtures/central" : "/fixtures/project-" + (i % 43);
    const projectKey = "/fixtures/checkout-" + i;
    return {
      id: String(i), source: "codex", title: "row-" + i, titleSource: "explicit", projectKey,
      linkedDirectories: [{ id: directory, path: directory, kind: "worktree", label: "Directory", worktreePath: projectKey }],
      ...(i < pins ? { pinnedRank: "r" + String(i).padStart(4, "0") } : {}),
      inbox: { inInbox: false }, threadStatus: "idle",
    };
  });
}

it.each([...cases, ...synthetic])("counts sidebar operations for %j", async (scenario) => {
  const shaped = "copies" in scenario;
  const threads = shaped ? generate({ copies: scenario.copies, archived: 0 }).threads : uniformThreads(scenario);
  const source = createSource(threads);
  const store = new NavigationQueryStore();
  const overlays = new Map(threads.map((row) => [row.id, {
    pinnedRank: row.pinnedRank, parentThreadId: row.parentThreadId, parentThreadBackend: row.parentThreadBackend,
  }]));
  const project = (rows) => rows.map((row) => ({ ...row, ...overlays.get(row.id), inbox: row.inbox ?? { inInbox: false } }));
  const counters = { providerLists: 0, checkoutPaths: 0, joined: 0, targeted: 0, directoryRows: 0 };
  const instrumented = process.env.AUDIT_LIVE_INDEX === "1";
  globalThis.auditCosts = { slotCopies: 0, lensTests: 0 };
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.spyOn(directoryStore, "readNavigationCheckouts").mockImplementation(async (paths) => {
    counters.checkoutPaths += paths.length;
    return [];
  });
  vi.spyOn(StackReader.prototype, "read").mockResolvedValue({ stacks: [], catalogs: [] });
  mocks.store.readNavigationQueryIndex.mockImplementation(({ threads }) => {
    counters.joined += threads.length;
    const rows = project(threads);
    return { threads: rows, directories: buildDirectorySummaries({ threads: rows }) };
  });
  mocks.store.readNavigationQueryThreads.mockImplementation(({ threads }) => {
    counters.targeted += threads.length;
    return { threads: project(threads) };
  });
  mocks.store.readNavigationQueryDirectories = (threads) => {
    counters.directoryRows += threads.length;
    return { directories: buildDirectorySummaries({ threads }) };
  };
  const read = (active = false) => store.readPage({
    incremental: true, scopeKey: "audit-owner", loadIndex: source.loadIndex,
    request: { protocol: 2, consumer: "main-sidebar", pageSize: 10,
      query: { kind: "lens", lens: "attention", ...(active ? { attention: "active" } : {}) } },
  });
  const update = (i, active) => {
    const row = threads[i];
    row.threadStatus = active ? "active" : "idle";
    source.emit(row.source, "thread/status/changed", { threadId: row.id, status: { type: row.threadStatus } });
  };
  const n = threads.length;
  let previous = {};
  const mark = (phase) => {
    counters.providerLists = source.listThreads.mock.calls.length;
    const current = { ...counters, ...(instrumented ? globalThis.auditCosts : {}) };
    const delta = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value - (previous[key] ?? 0)]));
    record({ kind: shaped ? "shape-navigation" : "navigation", n, ...scenario, phase, ...delta });
    previous = current;
  };
  try {
    await read();
    await source.waitForDiscovery();
    mark("cold");
    await vi.advanceTimersByTimeAsync(15001);
    await read(true);
    mark("expired");
    for (let i = 0; i < 8; i++) update(i, true);
    expect((await read(true)).counts.active).toBe(8);
    mark("8-batched");
    for (let i = 0; i < 8; i++) {
      update(i, false);
      expect((await read(true)).counts.active).toBe(7 - i);
    }
    mark("8-separated");
    if (!shaped) {
      const newborn = { ...threads[0], id: "new-thread", source: "claude", threadStatus: "active", title: "New" };
      threads.push(newborn);
      source.emit(newborn.source, "thread/started", { thread: newborn });
      await expect.poll(async () => (await read(true)).counts.active).toBe(1);
      mark("thread-start");
      threads.pop();
      source.emit(newborn.source, "thread/archived", { threadId: newborn.id });
      await expect.poll(async () => (await read(true)).counts.active).toBe(0);
      mark("archive");
    }
  } finally {
    delete globalThis.auditCosts;
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
