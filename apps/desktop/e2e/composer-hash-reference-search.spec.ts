import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("typing prose after a PR number does not reopen thread reference search", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/smoke/replay.fixture.json",
    ),
  });

  try {
    await app.window
      .getByRole("button", { name: /Replay smoke thread/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Replay smoke thread",
      }),
    ).toBeVisible();

    const reply = app.window.getByRole("textbox", { name: "Reply" });
    const remoteSearchStatus = app.window.getByText(
      "Searching other instances…",
    );

    // A numeric `#` reference is complete once the operator types a space.
    // Let the initial lookup settle, then observe the exact regression: every
    // later character used to reopen the remote-search status because the
    // trigger treated the rest of the line as part of the PR query.
    await reply.fill("But the thread has PR #1349 ");
    await expect(remoteSearchStatus).toHaveCount(0);

    await app.window.evaluate(() => {
      const state = {
        observer: undefined as MutationObserver | undefined,
        seen: false,
      };
      state.observer = new MutationObserver(() => {
        if (document.body.textContent?.includes("Searching other instances…")) {
          state.seen = true;
        }
      });
      state.observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      (window as typeof window & {
        __composerHashSearchRegression?: typeof state;
      }).__composerHashSearchRegression = state;
    });

    await reply.pressSequentially("so clearly it has changes.", { delay: 50 });

    const searchingPopupSeen = await app.window.evaluate(() => {
      const testWindow = window as typeof window & {
        __composerHashSearchRegression?: {
          observer?: MutationObserver;
          seen: boolean;
        };
      };
      const seen = testWindow.__composerHashSearchRegression?.seen ?? false;
      testWindow.__composerHashSearchRegression?.observer?.disconnect();
      delete testWindow.__composerHashSearchRegression;
      return seen;
    });

    expect(
      searchingPopupSeen,
      "ordinary prose after `#1349 ` should not flash thread search",
    ).toBe(false);
  } finally {
    await app.close();
  }
});
