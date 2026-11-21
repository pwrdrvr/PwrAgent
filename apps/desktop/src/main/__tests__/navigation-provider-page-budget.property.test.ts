import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";

async function listing(activePages: number, archivePages: number) {
  vi.useFakeTimers();
  const client = new CodexAppServerClient({ directoryResolver: async () => [] });
  // Exercise the real inventory walkers without launching an agent process.
  client["ensureInitialized"] = async () => {};
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    expect(method).toBe("thread/list");
    const native = (params.sourceKinds as string[]).includes("subAgent");
    const kind = native ? "native" : params.archived ? "archive" : "active";
    const page = params.cursor ? Number(String(params.cursor).split(":")[1]) : 1;
    const total = native ? 1 : params.archived ? archivePages : activePages;
    return { data: native ? [] : [{ id: `${kind}-${page}`, preview: `${kind} ${page}`, createdAt: page,
      updatedAt: page, status: { type: "idle" }, source: "cli" }],
    nextCursor: page < total ? `${kind}:${page + 1}` : null };
  });
  Object.defineProperty(client, "connection", { value: { request } });
  try {
    const rows = await client.listThreads({ enrichDirectories: false }, { callerReason: "renderer-navigation-query" });
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: activePages }, (_, i) => `active-${activePages - i}`));
    await vi.runOnlyPendingTimersAsync();
    await client.listNativeSubAgentThreads();
    const active = request.mock.calls.filter(([, params]) => params.archived === false && !(params.sourceKinds as string[]).includes("subAgent"));
    const archived = request.mock.calls.filter(([, params]) => params.archived === true);
    const native = request.mock.calls.filter(([, params]) => (params.sourceKinds as string[]).includes("subAgent"));
    expect({ active: active.length, archived: archived.length, native: native.length })
      .toEqual({ active: activePages, archived: archivePages, native: 1 });
    for (const [, params] of [...active, ...archived]) expect(params).toMatchObject({ limit: 50,
      sortKey: "updated_at", sourceKinds: ["cli", "vscode"], useStateDbOnly: true });
    expect(native[0]![1]).toMatchObject({ sourceKinds: ["subAgent", "subAgentThreadSpawn"], useStateDbOnly: true });
    expect(archived.at(-1)![1].cursor).toBe(archivePages === 1 ? undefined : `archive:${archivePages}`);
    // An archive-only row never enters active navigation. The next active
    // read must not schedule another metadata walk inside the TTL.
    request.mockClear();
    const next = await client.listThreads({ enrichDirectories: false });
    await vi.runOnlyPendingTimersAsync();
    expect(next.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(request.mock.calls).toHaveLength(activePages);
  } finally { await client.close(); vi.useRealTimers(); }
}

it.each([{ active: 6, archived: 43 }, { active: 12, archived: 86 }])(
  "budgets a complete active listing and its separate $archived-page metadata walk", ({ active, archived }) => listing(active, archived),
);

it("follows every provider cursor to completion rather than imposing a universal one-RPC navigation budget", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 8 }), listing), { numRuns: 25 });
});

it.each([43, 86])("shares %i archived pages between metadata refresh and archive membership", async (size) => {
  vi.useFakeTimers();
  const client = new CodexAppServerClient({ directoryResolver: async () => [] });
  client["ensureInitialized"] = async () => {};
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const request = vi.fn(async (_method: string, params: { archived: boolean; cursor?: string }) => {
    if (!params.archived) return { data: [{ id: "live", preview: "live", source: "cli" }], nextCursor: null };
    const page = params.cursor ? Number(params.cursor) : 1;
    if (page === 1) await held;
    return { data: [{ id: `archive-${page}`, preview: `archive ${page}`, source: "cli" }],
      nextCursor: page < size ? String(page + 1) : null };
  });
  Object.defineProperty(client, "connection", { value: { request } });
  try {
    expect((await client.listThreads({ enrichDirectories: false })).map((row) => row.id)).toEqual(["live"]);
    // The active listing queued a metadata walk. Start it before the cleanup
    // consumer asks for its own complete view of the same provider generation.
    await vi.runOnlyPendingTimersAsync();
    const membership = client.listThreads({ archived: true, enrichDirectories: false }, { callerReason: "archive-cleanup" });
    await Promise.resolve();
    release();
    expect(new Set((await membership).map((row) => row.id))).toEqual(new Set(Array.from({ length: size }, (_, i) => `archive-${i + 1}`)));
    expect(request.mock.calls.filter(([, params]) => params.archived)).toHaveLength(size);
  } finally {
    release();
    await client.close();
    vi.useRealTimers();
  }
});
