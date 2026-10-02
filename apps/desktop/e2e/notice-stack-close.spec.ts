// Paging and closing durable notices of one kind, with the pointer parked on
// the close button.
//
// The stack is anchored at the window's bottom-left and the close button
// sits in the card's top-right corner. Each kind of durable notice has one
// card, drawn over hidden copies of the kind's other notices so it takes the
// largest of their sizes: paging between notices of different heights, and
// closing one after another, leave the close button and the pager where they
// were. Closing the largest would shrink the card; while the pointer stays
// on the stack, it does not. jsdom lays nothing out, so this is the gate for
// the geometry; the logic is pinned in `AppNoticeStack.test.tsx`.
//
// The notices are federation shutdown notices, pushed on the agent-event
// channel exactly as main broadcasts them. Their titles carry the peer's
// label, so a long label makes a taller notice with no other difference.

import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  FEDERATION_SHUTDOWN_CHANGED_METHOD,
  type AgentEvent,
  type FederationPeerShutdown,
} from "@pwragent/shared";
import { AGENT_EVENT_CHANNEL } from "../src/shared/ipc";
import { launchElectronApp } from "./fixtures/electron-app";

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const measured = await locator.boundingBox();
  if (measured === null) {
    throw new Error(`Expected a laid-out box for ${locator}`);
  }
  return measured;
}

/** Within half a pixel: sub-pixel layout is not a jump under the pointer. */
function expectSameBox(actual: Box, expected: Box, message: string): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${message} (${key})`)
      .toBeLessThanOrEqual(0.5);
  }
}

/**
 * Waits out the card's finite animations. It slides 8px into place as it
 * enters, so a rect read during those 160ms is not where it comes to rest.
 */
async function settle(locator: Locator): Promise<void> {
  await locator.evaluate((element) =>
    Promise.all(
      element.getAnimations({ subtree: true })
        .filter((animation) =>
          animation.effect?.getComputedTiming().iterations !== Infinity
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ).then(() => undefined)
  );
}

function centre(target: Box): { x: number; y: number } {
  return { x: target.x + target.width / 2, y: target.y + target.height / 2 };
}

function peer(instanceId: string, label: string): FederationPeerShutdown {
  return {
    instanceId,
    label,
    shutdownId: `${instanceId}-quit`,
    revision: 1,
    state: "scheduled",
    reason: "quit",
    // Paused, so no countdown re-renders the message under the test.
    deadlineAt: null,
  } as FederationPeerShutdown;
}

/** The accessible name of the button under a point, or what is there. */
async function hitAt(page: Page, point: { x: number; y: number }) {
  return await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    const button = element?.closest("button");
    return button?.getAttribute("aria-label") ?? element?.className ?? null;
  }, point);
}

const LONG_LABEL =
  "Build server in the far rack by the window, second shelf from the top";

test("paging and closing one kind of notice never moves its controls", async () => {
  const app = await launchElectronApp({ requiresReplayDriver: false });

  try {
    const { window } = app;
    const peers = [
      peer("e2e-short", "Mini"),
      peer("e2e-tall", LONG_LABEL),
      peer("e2e-last", "Studio"),
    ];
    const event: AgentEvent = {
      backend: "codex",
      notification: {
        method: FEDERATION_SHUTDOWN_CHANGED_METHOD,
        params: { notices: peers },
      },
    } as AgentEvent;
    await app.electronApp.evaluate(
      ({ BrowserWindow }, params) => {
        const target = BrowserWindow.getAllWindows()[0];
        if (!target) throw new Error("Expected the main window");
        target.webContents.send(params.channel, params.event);
      },
      { channel: AGENT_EVENT_CHANNEL, event },
    );

    // The kind's card. Only the notice it shows carries an id; the hidden
    // copies it is sized by carry none.
    const card = window.locator(
      ".app-notice-toast[data-notice-id^='federation-shutdown:']",
    );
    await expect(card).toHaveAttribute(
      "data-notice-id",
      "federation-shutdown:e2e-short",
    );
    await expect(card).toContainText("1 of 3");
    await window.mouse.move(0, 0);
    await settle(card);
    const close = card.getByRole("button", { name: "Dismiss notice" });
    const next = card.getByRole("button", { name: "Next notice" });
    const title = card.locator(".app-notice-toast__title");
    const shortCard = await box(card);
    const shortTitle = await box(title);
    const first = await box(close);
    const pager = await box(next);

    // Paging to the tall notice and on: one card, one size, nothing clipped.
    for (const id of ["e2e-tall", "e2e-last"]) {
      await next.click();
      await window.mouse.move(0, 0);
      await expect(card).toHaveAttribute(
        "data-notice-id",
        `federation-shutdown:${id}`,
      );
      await settle(card);
      expectSameBox(await box(card), shortCard, `the card keeps its size on ${id}`);
      expectSameBox(await box(close), first, `the close stays put on ${id}`);
      const clipped = await card.locator(".app-notice-toast__content").evaluate(
        (content) => content.scrollHeight > content.clientHeight + 1,
      );
      expect(clipped, `${id} is not clipped`).toBe(false);
      // The tall notice really is taller: its title wraps. Without this, the
      // card could keep one size over notices of one height.
      if (id === "e2e-tall") {
        expect((await box(title)).height, "the tall title wraps")
          .toBeGreaterThan(shortTitle.height + 10);
      }
    }
    await card.getByRole("button", { name: "Previous notice" }).click();
    await card.getByRole("button", { name: "Previous notice" }).click();
    await expect(card).toHaveAttribute(
      "data-notice-id",
      "federation-shutdown:e2e-short",
    );
    expectSameBox(await box(next), pager, "the pager stays put");

    // A run of closes with the pointer parked on the close.
    const aim = centre(first);
    await window.mouse.move(aim.x, aim.y);
    for (const id of ["e2e-tall", "e2e-last"]) {
      await window.mouse.down();
      await window.mouse.up();
      await expect(card).toHaveAttribute(
        "data-notice-id",
        `federation-shutdown:${id}`,
      );
      expectSameBox(await box(close), first, `the close stays put on ${id}`);
      expect(await hitAt(window, aim)).toBe("Dismiss notice");
    }

    // The last notice alone is smaller, with no pager and no tall notice
    // to match: leaving the stack lets the card fit it.
    await window.mouse.move(0, 0);
    await expect(card).not.toHaveAttribute("data-held", "true");
    await settle(card);
    const lastCard = await box(card);
    expect(lastCard.height, "the card fits the last notice").toBeLessThan(
      shortCard.height - 10,
    );
    expect(Math.round(lastCard.width), "one width for the kind").toBe(
      Math.round(shortCard.width),
    );
  } finally {
    await app.close();
  }
});
