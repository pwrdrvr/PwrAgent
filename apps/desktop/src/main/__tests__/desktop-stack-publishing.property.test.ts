import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { buildThreadIdentityKey, type PrSummary } from "@pwragent/shared/contracts/navigation";
import type { StackLayer, StackSummary } from "@pwragent/shared/stacks/stack-status";
import { initializeDesktopAppServerService, resetAppServerServiceForTests } from "../app-server/desktop-app-server-service";

const { publishStackLayer } = vi.hoisted(() => ({ publishStackLayer: vi.fn() }));
vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => ({
    stackThreadActive: () => false,
    isThreadLocked: async () => false,
    publishStackLayer,
  }),
}));

afterEach(() => { vi.restoreAllMocks(); });

async function checkParentObservations(parentHeads: readonly number[]): Promise<void> {
  resetAppServerServiceForTests();
  const service = initializeDesktopAppServerService();
  service["ownerNavigationActive"] = true;
  service["backgroundPrPollingEnabled"] = true;
  publishStackLayer.mockReset().mockRejectedValue(new Error("Transient publish failure"));

  const upperPr: PrSummary = {
    number: 2, provider: "github.com", org: "fixture", repo: "stack", state: "passing",
    url: "https://github.com/fixture/stack/pull/2", lifecycleState: "open",
    headRefName: "upper", baseRefName: "lower", headSha: "a".repeat(40),
  };
  const upper: StackLayer = {
    branch: "upper", parent: "lower", health: "needs_restack", unsettled: "needs restack",
    role: "layer", thread: { key: buildThreadIdentityKey("codex", "upper-thread"), title: "Upper layer" },
    pullRequest: { number: 2, lifecycleState: "open" },
  };
  const stack: StackSummary = {
    key: "fixture-stack", name: "Stack", repository: "github.com:fixture/stack", inferred: false, trunk: "main",
    layers: [
      { branch: "lower", parent: "main", health: "in_sync", role: "unbound", pullRequest: { number: 1, lifecycleState: "open" } },
      upper,
    ],
  };

  let previousHead: number | undefined;
  let expectedAttempts = 0;
  for (const [index, head] of parentHeads.entries()) {
    const parent: PrSummary = {
      ...upperPr, number: 1, url: "https://github.com/fixture/stack/pull/1",
      headRefName: "lower", baseRefName: "main", headSha: head.toString(16).padStart(40, "0"),
    };
    service["rememberPrStatuses"]([parent, upperPr], index + 1, "background-poll");
    await service["advanceStackFromObservation"](upperPr, stack, upper);

    // During the cooldown, only a changed parent head allows another try.
    if (head !== previousHead) expectedAttempts += 1;
    expect(publishStackLayer).toHaveBeenCalledTimes(expectedAttempts);
    expect(publishStackLayer).toHaveBeenLastCalledWith(
      expect.objectContaining({ number: upperPr.number, expectedHeadSha: upperPr.headSha }),
      expect.objectContaining({ backend: "codex", threadId: "upper-thread" }),
    );
    previousHead = head;
  }
}

it("retries a failed upper-layer publish when the parent head changes during cooldown", async () => {
  vi.spyOn(Date, "now").mockReturnValue(10_000);
  await checkParentObservations([1, 1, 2, 2]);
});

it("throttles repeated parent heads while retrying on each newly observed head", async () => {
  vi.spyOn(Date, "now").mockReturnValue(10_000);
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 2, maxLength: 12 }),
    checkParentObservations), { numRuns: 25 });
});
