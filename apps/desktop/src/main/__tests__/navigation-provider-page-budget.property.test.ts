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
