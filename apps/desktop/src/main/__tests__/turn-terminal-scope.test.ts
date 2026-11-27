import { expect, it, vi } from "vitest";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { createOverlayStoreMock, discoverCodexBackendForTest, MockBackendClient } from "./helpers/backend-registry-fixture";

it.each(["provider", "stop"] as const)("settles a %s terminal without enumerating the owner's activities or reviews", async (path) => {
  const client = new MockBackendClient({
    threads: [],
    initializeResult: { methods: ["turn/interrupt", "thread/resume"] },
    interruptEndsTurn: true,
  });
  const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
  const state = registryModules(registry).turnState;
  const target = { backend: "codex" as const, threadId: "target", turnId: "turn" };
  const unrelated = { backend: "codex" as const, threadId: "target:child", turnId: "other-root" };
  const claude = { ...target, backend: "claude" as const };
  try {
    await discoverCodexBackendForTest(registry);
    state.acceptExecution(unrelated, "default");
    state.setReviewInterrupt(unrelated, target.turnId);
    state.registerTurn(claude);
    state.activateReview({
      backend: "codex", parentBackend: "claude", parentThreadId: "parent", reviewThreadId: "child",
      turnId: "review", createdAt: 0, displayText: "Review", task: "Review", mode: "managed",
    });
    state.acceptExecution(target, "default");
    // Measure only delivery. Stop also does its own lookup before calling the provider.
    const emit = client.emit.bind(client);
    let deliveries = 0;
    let activityScans = 0;
    let reviewSnapshots = 0;
    vi.spyOn(client, "emit").mockImplementation(async notification => {
      const activities = state["activities"];
      const enumerations = [
        vi.spyOn(activities, Symbol.iterator), vi.spyOn(activities, "entries"),
        vi.spyOn(activities, "keys"), vi.spyOn(activities, "values"), vi.spyOn(activities, "forEach"),
      ];
      const reviews = vi.spyOn(state, "liveReviewRecords");
      try {
        await emit(notification);
        deliveries++;
        for (const spy of enumerations) activityScans += spy.mock.calls.length;
        reviewSnapshots += reviews.mock.calls.length;
      } finally {
        for (const spy of enumerations) spy.mockRestore();
        reviews.mockRestore();
      }
    });
    if (path === "provider") {
      await client.emit({
        method: "turn/completed",
        params: { threadId: target.threadId, turnId: target.turnId, turn: { id: target.turnId, status: "completed", output: [] } },
      });
    } else {
      expect(await registry.controlActiveTurn({ ...target, operation: "stop", requestId: "stop" })).toMatchObject({ ok: true, turnId: target.turnId });
    }
    expect(deliveries).toBe(1);
    expect(state.ownsExecution(target)).toBe(false);
    expect(state.ownsExecution(unrelated)).toBe(true);
    expect(state.hasRegisteredTurn(claude)).toBe(true);
    expect(state.reviewInterrupt(unrelated)).toBe(target.turnId);
    expect({ activityScans, reviewSnapshots }).toEqual({ activityScans: 0, reviewSnapshots: 0 });
  } finally {
    state.finishReview("codex:child:review");
    state.forgetExecution(target);
    state.forgetReviewInterrupt(unrelated);
    state.forgetExecution(unrelated);
    state.unregisterTurn(claude);
    await registry.close();
  }
});
