import type { Page } from "@playwright/test";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { waitForCreatedThreadTranscript } from "../../../e2e/fixtures/created-thread";

type ModeledLocator = {
  waitFor: () => Promise<void>;
  assertVisible: () => Promise<void>;
};

vi.mock("@playwright/test", () => ({
  expect: (locator: ModeledLocator) => ({ toBeVisible: () => locator.assertVisible() }),
}));

const title = "Thread composer regression";

/**
 * Owner oracle: submission shows Preparing transcript, then materialization
 * transfers selection to Transcript; the navigation title may hydrate later.
 * Model Playwright's two existing budgets with a virtual clock, not sleeps:
 * locator actions inherit electron-app's 20s, assertions have their own 5s.
 */
function startupModel(ownerReadyAt: number, titleHydrationMs: number) {
  let now = 0;
  const waitUntil = async (visibleAt: number, budget: number) => {
    if (visibleAt > now + budget) {
      throw new Error(`not visible within ${budget}ms at ${now}ms; owner ready at ${ownerReadyAt}ms`);
    }
    now = Math.max(now, visibleAt);
  };
  const transcript: ModeledLocator = {
    waitFor: async () => waitUntil(ownerReadyAt, 20_000),
    assertVisible: async () => waitUntil(ownerReadyAt, 5_000),
  };
  const page = {
    getByRole: (role: string, options: { name: string; exact?: boolean; level?: number }) => {
      if (role === "region" && options.name === "Transcript") {
        // A substring also matches the startup placeholder. It cannot answer
        // whether the real thread owns the pane yet.
        return options.exact ? transcript : {
          waitFor: async () => waitUntil(0, 20_000),
          assertVisible: async () => waitUntil(0, 5_000),
        };
      }
      const visibleAt = role === "heading" && options.name === title && options.level === 2
        ? ownerReadyAt + titleHydrationMs
        : Infinity;
      return {
        waitFor: async () => waitUntil(visibleAt, 20_000),
        assertVisible: async () => waitUntil(visibleAt, 5_000),
      };
    },
  } as unknown as Page;
  return { page, transcript, now: () => now };
}

it("hands the pane to the created thread for every startup schedule within the existing action budget", async () => {
  // Rule: owner startup latency must not consume the selected-title assertion's
  // budget; image checks begin only in the real, correctly selected transcript.
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 15_000 }),
    fc.integer({ min: 0, max: 4_999 }),
    async (ownerReadyAt, titleHydrationMs) => {
      const model = startupModel(ownerReadyAt, titleHydrationMs);
      const transcript = await waitForCreatedThreadTranscript(model.page, title);
      expect(transcript).toBe(model.transcript);
      expect(model.now()).toBe(ownerReadyAt + titleHydrationMs);
    },
  ));
});

it("waits through Preparing transcript when materialization outlasts the heading assertion budget", async () => {
  const model = startupModel(5_001, 0);
  await expect(waitForCreatedThreadTranscript(model.page, title)).resolves.toBe(model.transcript);
});

it("still rejects the wrong selected thread after the real transcript becomes ready", async () => {
  const model = startupModel(6_000, 0);
  await expect(waitForCreatedThreadTranscript(model.page, "Wrong thread")).rejects.toThrow("not visible within 5000ms");
});
