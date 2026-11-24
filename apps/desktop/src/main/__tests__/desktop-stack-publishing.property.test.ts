import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { buildThreadIdentityKey, type PrSummary } from "@pwragent/shared/contracts/navigation";
import type { StackLayer, StackSummary } from "@pwragent/shared/stacks/stack-status";
import { initializeDesktopAppServerService, resetAppServerServiceForTests } from "../app-server/desktop-app-server-service";
import { ForgeReadError } from "../pr-status/forge-tool-contract";

const { publishStackLayer } = vi.hoisted(() => ({ publishStackLayer: vi.fn() }));
vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => ({
    stackThreadActive: () => false,
    isThreadLocked: async () => false,
    publishStackLayer,
  }),
}));

afterEach(() => { vi.restoreAllMocks(); });

const firstChildHead = "a".repeat(40);
const secondChildHead = "b".repeat(40);

function startPublishPolling(failure: Error) {
  resetAppServerServiceForTests();
  const service = initializeDesktopAppServerService();
  service["ownerNavigationActive"] = true;
  service["backgroundPrPollingEnabled"] = true;
  publishStackLayer.mockReset().mockRejectedValue(failure);

  const upperPr: PrSummary = {
    number: 2, provider: "github.com", org: "fixture", repo: "stack", state: "passing",
    url: "https://github.com/fixture/stack/pull/2", lifecycleState: "open",
    headRefName: "upper", baseRefName: "lower",
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

  let fetchedAt = 0;
  return async (parentHead: number, childHead = firstChildHead) => {
    const parent: PrSummary = {
      ...upperPr, number: 1, url: "https://github.com/fixture/stack/pull/1",
      headRefName: "lower", baseRefName: "main", headSha: parentHead.toString(16).padStart(40, "0"),
    };
    const child = { ...upperPr, headSha: childHead };
    service["rememberPrStatuses"]([parent, child], ++fetchedAt, "background-poll");
    await service["advanceStackFromObservation"](child, stack, upper);
  };
}

async function checkParentObservations(parentHeads: readonly number[]): Promise<void> {
  const observe = startPublishPolling(new Error("Transient publish failure"));
  let previousHead: number | undefined;
  let expectedAttempts = 0;
  for (const head of parentHeads) {
    await observe(head);

    // During the cooldown, only a changed parent head allows another try.
    if (head !== previousHead) expectedAttempts += 1;
    expect(publishStackLayer).toHaveBeenCalledTimes(expectedAttempts);
    expect(publishStackLayer).toHaveBeenLastCalledWith(
      expect.objectContaining({ number: 2, expectedHeadSha: firstChildHead }),
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

async function checkDeclinedObservations(observations: readonly { parentHead: number; childHead: string }[]) {
  const observe = startPublishPolling(new ForgeReadError("declined", "Operator declined stack publishing"));
  let previousChildHead: string | undefined;
  let expectedAttempts = 0;
  for (const { parentHead, childHead } of observations) {
    await observe(parentHead, childHead);

    // A decline suppresses further requests for this child head.
    if (childHead !== previousChildHead) expectedAttempts += 1;
    expect(publishStackLayer).toHaveBeenCalledTimes(expectedAttempts);
    expect(publishStackLayer).toHaveBeenLastCalledWith(
      expect.objectContaining({ number: 2, expectedHeadSha: childHead }),
      expect.objectContaining({ backend: "codex", threadId: "upper-thread" }),
    );
    previousChildHead = childHead;
  }
}

it("keeps a decline after the parent moves and allows a request for a new child head", async () => {
  await checkDeclinedObservations([
    { parentHead: 1, childHead: firstChildHead },
    { parentHead: 2, childHead: firstChildHead },
    { parentHead: 2, childHead: secondChildHead },
  ]);
});

it("keys declined publish requests to the child head across parent and child updates", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    parentHead: fc.integer({ min: 1, max: 4 }),
    childHead: fc.constantFrom(firstChildHead, secondChildHead),
  }), { minLength: 2, maxLength: 12 }), checkDeclinedObservations), { numRuns: 25 });
});
