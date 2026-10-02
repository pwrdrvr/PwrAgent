// Closing durable notices one after another, with the pointer parked on the
// close button.
//
// The stack is anchored at the window's bottom-left and the close button
// sits in the card's top-right corner. The next durable notice draws in the
// same card, so before the card held its size, a next notice of another
// height moved the close button out from under the pointer, and the second
// click of a run landed on the notice's text or on the app behind it. jsdom
// lays nothing out, so this is the gate for the geometry; the hold's logic is
// pinned in `AppNoticeStack.test.tsx`.
//
// The notices are federation shutdown notices, pushed on the agent-event
// channel exactly as main broadcasts them. Their titles carry the peer's
// label, so a long label makes a taller card with no other difference.

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

test("a run of closes keeps the close button under the pointer", async () => {
  const app = await launchElectronApp({ requiresReplayDriver: false });

  try {
    const { window } = app;
    const peers = [
      peer("e2e-short", "Mini"),
      peer(
        "e2e-tall",
        "Build server in the far rack by the window, second shelf from the top",
      ),
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

    // The durable card. A runner with no agent installed can already hold a
    // backend warning there, ahead of these, so page to the first of ours.
    const card = window.locator(".app-notice-toast[data-navigable]");
    await expect(card).toBeVisible();
    for (let step = 0; step < 10; step += 1) {
      if (await card.getAttribute("data-notice-id") === "federation-shutdown:e2e-short") {
        break;
      }
      await card.getByRole("button", { name: "Next notice" }).click();
    }
    await expect(card).toHaveAttribute(
      "data-notice-id",
      "federation-shutdown:e2e-short",
    );
    // Paging under the pointer holds the card too; start from rest.
    await window.mouse.move(0, 0);
    await expect(card).not.toHaveAttribute("data-held", "true");
    await settle(card);
    const close = card.getByRole("button", { name: "Dismiss notice" });
    const shortCard = await box(card);
    const first = await box(close);
    const aim = centre(first);

    await window.mouse.move(aim.x, aim.y);
    await window.mouse.down();
    await window.mouse.up();
    await expect(card).toHaveAttribute(
      "data-notice-id",
      "federation-shutdown:e2e-tall",
    );
    expectSameBox(await box(close), first, "the close stays put after a close");
    expect(await hitAt(window, aim)).toBe("Dismiss notice");

    // The tall notice really is taller: leaving the stack lets it fit, and
    // its close moves up. Without this, the assertion above could pass on
    // two notices of one height.
    await window.mouse.move(0, 0);
    await expect(card).not.toHaveAttribute("data-held", "true");
    await settle(card);
    const tallCard = await box(card);
    expect(tallCard.height, "the second notice is taller").toBeGreaterThan(
      shortCard.height + 10,
    );
    const tallClose = await box(close);
    expect(tallClose.y).toBeLessThan(first.y);

    // And the other direction: closing the tall one under the pointer keeps
    // its close where it was while a shorter notice takes the card.
    const tallAim = centre(tallClose);
    await window.mouse.move(tallAim.x, tallAim.y);
    await window.mouse.down();
    await window.mouse.up();
    await expect(card).toHaveAttribute(
      "data-notice-id",
      "federation-shutdown:e2e-last",
    );
    expectSameBox(
      await box(close),
      tallClose,
      "the close stays put after a second close",
    );
    expect(await hitAt(window, tallAim)).toBe("Dismiss notice");
  } finally {
    await app.close();
  }
});
