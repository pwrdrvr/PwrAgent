import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_FORGE_AUTOMATION } from "@pwragent/shared/project-forge-automation";
import { selectPrReviewOfferOwner } from "../pr-status/pr-review-offer-owner";

describe("selectPrReviewOfferOwner with hands-off PRs", () => {
  it("gives a hands-off PR's offers to no thread whose project leaves it alone", async () => {
    const readWinner = vi.fn(async () => undefined);
    expect(await selectPrReviewOfferOwner({
      candidates: [{
        backend: "codex",
        threadId: "upstream",
        archived: false,
        automation: { ...DEFAULT_PROJECT_FORGE_AUTOMATION, handsOff: [{ repository: "canvas-org/canvas" }] },
        handsOff: true,
      }],
      readWinner,
    })).toBeUndefined();
  });

  it("still offers to a thread in another project that does not leave it alone", async () => {
    expect(await selectPrReviewOfferOwner({
      candidates: [
        { backend: "codex", threadId: "hands-off", archived: false, automation: undefined, handsOff: true },
        { backend: "codex", threadId: "other", archived: false, automation: undefined },
      ],
      readWinner: async () => ({ backend: "codex", threadId: "hands-off" }),
    })).toEqual({ backend: "codex", threadId: "other" });
  });
});
