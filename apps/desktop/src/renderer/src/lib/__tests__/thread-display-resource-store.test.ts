import { expect, it, vi } from "vitest";
import {
  buildThreadPricingDisplay,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { ThreadDisplayResourceStore } from "../thread-display-resource-store";

const request: AppServerReadThreadRequest = {
  backend: "codex", threadId: "thread", includeTurns: false, viewOnly: true,
  display: { resource: "pricing", limit: 20, deferPricingGates: true },
};

/** Serves `rows` Pricing rows. With `emptyAfterFirst`, later pages are empty but still name a next page. */
function owner(params: { rows: number }) {
  let revision = "before";
  let emptyAfterFirst = false;
  const readThread = vi.fn(async (read: AppServerReadThreadRequest): Promise<AppServerReadThreadResponse> => {
    const display = read.display!;
    const offset = display.cursor ? Number(display.cursor.split(":")[1]) : 0;
    const empty = emptyAfterFirst && offset > 0;
    const end = empty ? offset : Math.min(params.rows, offset + (display.limit ?? 20));
    const next = empty ? offset + (display.limit ?? 20) : end;
    return {
      backend: "codex", threadId: "thread", fetchedAt: 1,
      replay: { entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
      display: {
        pricing: buildThreadPricingDisplay({}), revision,
        pricingPage: { ...buildThreadPricingDisplay({}),
          rows: Array.from({ length: end - offset }, (_, index) => ({ id: `${revision}-${offset + index}` })),
          totalRows: params.rows } as never,
        ...(next < params.rows ? { nextCursor: `${revision}:${next}` } : {}),
      },
    };
  });
  return { api: { readThread } satisfies DesktopApi, readThread,
    setRevision: (value: string) => { revision = value; },
    emptyLaterPages: () => { emptyAfterFirst = true; } };
}

it("re-reads more loaded rows than one bulk page holds in as few pages as the cap allows", async () => {
  const fake = owner({ rows: 2_000 });
  const store = new ThreadDisplayResourceStore(fake.api, request, { bulkReads: true });
  const unsubscribe = store.subscribe(() => undefined);
  await store.whenSettled();
  for (let page = 1; page < 60; page += 1) await store.loadMore();
  expect(store.getSnapshot().data?.pricingPage?.rows).toHaveLength(1_200);
  fake.readThread.mockClear();
  fake.setRevision("after");
  await store.refresh();
  expect(fake.readThread.mock.calls.map(([read]) => read.display?.limit)).toEqual([1_000, 200]);
  const rows = store.getSnapshot().data?.pricingPage?.rows as unknown as Array<{ id: string }>;
  expect(rows).toHaveLength(1_200);
  expect(rows.every((row) => row.id.startsWith("after-"))).toBe(true);
  unsubscribe();
});

it("stops a refresh when a page adds no rows", async () => {
  const fake = owner({ rows: 100 });
  // Legacy pages: the refresh needs a second page to reach its 40 loaded rows.
  const store = new ThreadDisplayResourceStore(fake.api, request);
  const unsubscribe = store.subscribe(() => undefined);
  await store.whenSettled();
  await store.loadMore();
  expect(store.getSnapshot().data?.pricingPage?.rows).toHaveLength(40);
  fake.readThread.mockClear();
  fake.setRevision("after");
  fake.emptyLaterPages();
  // The second page names a next page but adds nothing; the refresh must end.
  await store.refresh();
  expect(fake.readThread).toHaveBeenCalledTimes(2);
  expect(store.getSnapshot().data?.pricingPage?.rows).toHaveLength(20);
  expect(store.getSnapshot().error).toBeUndefined();
  unsubscribe();
}, 5_000);
