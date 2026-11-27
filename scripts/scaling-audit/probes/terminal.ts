import { expect, it, vi } from "vitest";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { createOverlayStoreMock, discoverCodexBackendForTest, MockBackendClient } from "./helpers/backend-registry-fixture";
import { record } from "./scaling-audit-results";

function observeMapTraversal(map, visit) {
  for (const name of [Symbol.iterator, "entries", "keys", "values"]) {
    const iterate = map[name].bind(map);
    Object.defineProperty(map, name, {
      configurable: true,
      value: function* () {
        for (const value of iterate()) {
          visit();
          yield value;
        }
      },
    });
  }
  const forEach = map.forEach.bind(map);
  Object.defineProperty(map, "forEach", {
    configurable: true,
    value: (callback, context) => forEach((value, key) => {
      visit();
      callback.call(context, value, key, map);
    }),
  });
}

it.each([[8, 1], [16, 1], [32, 1], [8, 4], [8, 16], [16, 4], [32, 16]])(
  "delivers terminal with %i unrelated entries per type and %i targets", async (n, k) => {
    const client = new MockBackendClient({
      threads: [], initializeResult: { methods: ["turn/interrupt", "thread/resume"] }, interruptEndsTurn: true,
    });
    const registry = createDesktopBackendRegistry({
      codexClient: client, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null,
    });
    const state = registryModules(registry).turnState;
    let measuring = false;
    let activity = 0;
    let reviews = 0;
    try {
      await discoverCodexBackendForTest(registry);
      for (let i = 0; i < n; i++) {
        const threadId = "background-" + i;
        const turnId = "held-" + i;
        state.acceptExecution({ backend: "codex", threadId, turnId }, "default");
        state.registerTurn({ backend: "claude", threadId, turnId });
        state.activateReview({
          backend: "codex", parentBackend: "claude", parentThreadId: threadId, reviewThreadId: "child-" + i,
          turnId: "review-" + i, createdAt: 0, displayText: "Review", task: "Review", mode: "managed",
        });
      }
      observeMapTraversal(state.activities, () => { if (measuring) activity++; });
      const observed = new WeakSet();
      const read = state.liveReviewRecords.bind(state);
      vi.spyOn(state, "liveReviewRecords").mockImplementation(() => {
        const records = read();
        if (!observed.has(records)) {
          observed.add(records);
          observeMapTraversal(records, () => { if (measuring) reviews++; });
        }
        return records;
      });
      for (const via of ["provider", "stop"]) {
        const targets = Array.from({ length: k }, (_, i) => ({
          backend: "codex", threadId: "operator-" + i, turnId: via + "-" + i,
        }));
        for (const target of targets) state.acceptExecution(target, "default");
        activity = reviews = 0;
        measuring = true;
        for (const target of targets) {
          if (via === "provider") {
            await client.emit({ method: "turn/completed", params: {
              ...target, turn: { id: target.turnId, status: "completed", output: [] },
            } });
          } else {
            expect((await registry.controlActiveTurn({ ...target, operation: "stop", requestId: target.turnId })).ok).toBe(true);
          }
          expect(state.ownsExecution(target)).toBe(false);
        }
        measuring = false;
        record({ kind: "terminal", n, k, via, activity, reviews });
      }
    } finally {
      measuring = false;
      vi.restoreAllMocks();
      await registry.close();
    }
  },
);
