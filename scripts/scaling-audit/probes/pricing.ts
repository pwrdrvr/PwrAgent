import { record } from "./scaling-audit-results";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { expect, it, onTestFinished, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const usage = (backend: string, turnId: string) => ({
  backend,
  notification: {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId,
      tokenUsage: {
        last: { inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 20, totalTokens: 1_020 },
        total: { inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 20, totalTokens: 1_020 },
      },
    },
  },
});
const started = (backend: string, turnId: string) => ({
  backend,
  notification: {
    method: "turn/started",
    params: { threadId: "thread-1", turnId, turn: { id: turnId, status: "inProgress" } },
  },
});
it("measures owner notifications and a four-row historical page over a growing conversation", async () => {
  const stateDb = openInMemoryStateDb();
  const store = new SqliteOverlayStore(stateDb);
  const registry = createDesktopBackendRegistry({
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => [], onNotification: () => () => {}, onPendingRequest: () => () => {},
    },
    overlayStore: store, runtimeInstanceId: "runtime-self", resolveLiveProfileRuntimeInstanceIds: () => [],
  });
  onTestFinished(async () => {
    await registry.close();
    stateDb.close();
    vi.restoreAllMocks();
  });
  const backend = "acp:antigravity";
  const request = { backend, threadId: "thread-1", display: { resource: "pricing", limit: 4, deferPricingGates: true }, includeTurns: false, viewOnly: true } as const;
  let eventRows = 0, bytes = 0, events = 0, readRows = 0, returned = 0, measuring = false;
  let fullPageRows = 0;
  const ledger = store.readThreadPricing.bind(store);
  vi.spyOn(store, "readThreadPricing").mockImplementation(async (args) => {
    const result = await ledger(args);
    if (measuring) fullPageRows += result.lines.length;
    return result;
  });
  const prepare = stateDb.raw.prepare.bind(stateDb.raw);
  vi.spyOn(stateDb.raw, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (/SELECT/i.test(sql) && /thread_usage_lines/.test(sql)) for (const name of ["get","all"] as const) {
      const read = statement[name].bind(statement);
      Object.assign(statement, { [name]: (...args) => {
        const value = read(...args);
        if (measuring) for (const row of Array.isArray(value) ? value : [value]) {
          if (row && typeof row === "object" && "usage_line_id" in row) readRows++;
        }
        return value;
      }});
    }
    return statement;
  });
  registry.onEvent(({ notification }) => {
    if (notification.method !== "thread/pricing/updated") return;
    events++;
    eventRows += notification.params.pricing.lines.length;
    bytes += Buffer.byteLength(JSON.stringify(notification));
  });
  const turnId = (n) => "turn-" + String(n).padStart(3, "0");
  for (let n = 1; n <= 64; n++) {
    const id = turnId(n);
    await registry.publishLocalEvent(started(backend, id));
    await registry.publishLocalEvent(usage(backend, id));
    await registry.publishLocalEvent({ backend, notification: {
      method: "turn/completed", params: { threadId: "thread-1", turnId: id, turn: { id, status: "completed", output: [] } },
    } });
    measuring = true;
    const page = (await registry.readThread(request)).display?.pricingPage;
    measuring = false;
    expect(page?.totalRows).toBe(n);
    expect(page?.rows.map((row) => row.line.turnId)).toEqual(
      Array.from({ length: Math.min(n, 4) }, (_, i) => turnId(n - i)),
    );
    returned += page.rows.length;
    if ([8, 16, 32, 64].includes(n)) {
      record({ kind: "pricing", n, events, eventRows, bytes, readRows, fullPageRows, returned });
    }
  }
});
