// A chat card opened before this instance knows its own id must survive
// learning it.
//
// `StarMapScreen` names the local instance `health?.instanceId ?? "local"`,
// and a card's `key` embeds that owner. When the federation-health read
// resolves, `remapOwner` rewrites every local card's key to the durable id
// — so keying React on it remounts every open card at that moment. The
// remount restarts the card's exact detail read, which drops its composer
// back to `data-composer-block="detail:none"` and refuses keystrokes until
// the read completes again, and it discards card-local state (staged
// attachments included).
//
// This is what `star-map-composer-attachments.spec.ts` was failing on in
// `Windows Desktop E2E (lane 3 of 4)`: Windows IPC is slow enough to put
// the health read AFTER the first card is opened, so the card was live at
// that spec's `toBeEditable()` barrier and dead ~250ms later at its
// keystroke. macOS and Linux resolve health long before any spec clicks a
// thread, which is why the ordering never appeared there — so this spec
// creates it deliberately rather than waiting for a platform to supply it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { recordDomTrajectory } from "./fixtures/dom-trajectory";
import { launchElectronApp } from "./fixtures/electron-app";
import { openStarMapWindow } from "./fixtures/star-map-window";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const THREAD_TITLE = "Star map attention thread";
/** Long enough to open the card and see its composer go live first. */
const HEALTH_DELAY_MS = 2_500;

test("keeps an open Star Map chat card mounted when federation health lands late", async () => {
  test.slow();
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/star-map/composer-attachments.fixture.json",
    ),
  });

  try {
    // Replace the handler rather than wrapping it, the same way
    // `star-map-activity.spec.ts` stubs its own load channel: the renderer
    // reads `health.instanceId` and `health.peers` and nothing else here,
    // and a synthetic answer is what makes the arrival time controllable.
    await app.electronApp.evaluate(async ({ ipcMain }, delayMs) => {
      const channel = "federation:get-health";
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return {
          health: {
            enabled: true,
            instanceId: "e2e-durable-instance",
            peers: [],
            role: "client",
            status: "connecting",
          },
        };
      });
    }, HEALTH_DELAY_MS);

    const mapWindow = await openStarMapWindow(app);
    const trajectory = await recordDomTrajectory(mapWindow, {
      attributes: ["data-composer-block", "data-card-mount"],
      editableSelector: ".composer-tiptap-input__editor",
      selector: ".star-map-chat-card",
    });

    const starMap = mapWindow.getByRole("region", {
      name: "Star Map",
      exact: true,
    });
    await expect(starMap).toBeVisible();
    const threadCard = starMap.getByRole("button", {
      name: `Open thread: ${THREAD_TITLE}`,
    });
    await expect(threadCard).toBeVisible({ timeout: 30_000 });
    await threadCard.click();

    const chatCard = mapWindow.getByRole("region", {
      name: `Chat: ${THREAD_TITLE}`,
    });
    await expect(chatCard).toBeVisible();
    const messageInput = chatCard.getByRole("textbox", {
      name: `Message ${THREAD_TITLE}`,
    });
    await expect(messageInput).toBeEditable();
    const mountedAs = await chatCard.getAttribute("data-card-mount");
    expect(mountedAs).not.toBeNull();

    // The card is live and health has NOT arrived. Hold past its arrival.
    await mapWindow.waitForTimeout(HEALTH_DELAY_MS + 1_500);

    // Same card instance — a remount would have stepped this counter, and
    // taken the card's staged state with it.
    expect(await chatCard.getAttribute("data-card-mount")).toBe(mountedAs);
    // And the composer was never withdrawn on the way. Asserted from the
    // trajectory rather than a final read, because the withdrawal this
    // guards against is transient: the card re-authorizes ~25ms later, so
    // reading the end state alone passes against the bug.
    const withdrawals = (await trajectory.read()).filter(
      (sample) =>
        sample.includes("data-composer-block=detail:")
        || sample.includes("data-composer-block=queue:"),
    );
    expect(
      withdrawals,
      "the composer was withheld after it first went live; the trajectory is"
      + ` ${JSON.stringify(await trajectory.read(), null, 2)}`,
    ).toHaveLength(1);
    await trajectory.stop();
  } finally {
    await app.close();
  }
});
