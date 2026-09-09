import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

/**
 * The launchpad's send controls must stay reachable no matter how much
 * sits above them.
 *
 * `.thread-view__primary` is a flex column whose only flexible child used
 * to be nothing at all: the two PwrSuite connection cards were direct
 * children sized to their own content, and the composer was pinned under
 * them with `margin-top: auto` at `flex: 0 0 auto`. Nothing in that column
 * could shrink, and `.thread-view` clips with `overflow: hidden`, so once
 * the cards plus a composer holding pasted images exceeded the pane the
 * whole composer simply walked off the bottom edge — no scrollbar, no way
 * to reach "Start thread".
 *
 * Negative-controlled on the macOS CI lane against the shipped layout (a
 * `TEMP:` commit reverting only the fix, since a geometry assertion written
 * after a fix agrees with the fix by construction): both cards render at
 * 253px and 316px, the composer at 401px, and the send row's bottom lands
 * at 725px in a 600px pane — 125px past the clip, with `startHitsItself`
 * false, on the run and on the retry. The same failure measured 56px past
 * at 800px and 142px at 700px in a headless-Chromium harness over the
 * shipped stylesheet.
 *
 * The invariant this pins is deliberately framed against the clipping
 * ancestor, not against any box the broken layout produces — an assertion
 * derived from the geometry under test agrees with the bug by
 * construction. The preconditions below exist for the same reason: without
 * them a taller window (or a card that stopped rendering) would make this
 * pass while proving nothing.
 */

// Short enough that the two connection cards plus a composer holding three
// pasted images cannot all fit. The precondition assertion below re-checks
// that on the machine actually running this rather than trusting the
// number, because a window that quietly grew past the crowding would make
// every assertion here pass while proving nothing.
const WINDOW = { width: 1280, height: 600 };

// Sub-pixel rounding on HiDPI. A real regression moves the send row by
// tens of pixels (56 and 142 above), so this is nowhere near it.
const BOUNDS_TOLERANCE_PX = 2;

async function createLaunchpadBoundsFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-launchpad-bounds-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  await mkdir(repoDir, { recursive: true });

  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-B", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=PwrAgent Tests",
      "-c",
      "user.email=pwragent-tests@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Seed fixture repo",
    ],
    { cwd: repoDir, stdio: "ignore" },
  );

  const fixturePath = path.join(rootDir, "launchpad-composer-bounds.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "launchpad-composer-bounds",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: { name: "Replay Codex", version: "1.0.0" },
              methods: ["thread/list", "thread/read", "skills/list", "thread/start", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-existing",
                title: "Existing directory thread",
                titleSource: "explicit",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [
                  {
                    id: "fixture-repo",
                    label: "FixtureRepo",
                    path: repoDir,
                    kind: "local",
                  },
                ],
                updatedAt: 1_000,
              },
            ],
          },
          {
            id: "thread-read-1",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "thread-existing-message-1",
                  role: "assistant",
                  text: "Existing directory thread",
                },
              ],
              messages: [
                {
                  id: "thread-existing-message-1",
                  role: "assistant",
                  text: "Existing directory thread",
                },
              ],
              lastAssistantMessage: "Existing directory thread",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    fixturePath,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

/** Pastes one solid-colour PNG into the composer, the way the operator does. */
async function pastePng(input: Locator, name: string, color: string): Promise<void> {
  await input.evaluate(async (element, params) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas context not available");
    context.fillStyle = params.color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error("Could not create PNG blob"));
      }, "image/png");
    });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([blob], params.name, { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  }, { color, name });
}

test("launchpad send controls stay on screen under both connection cards and pasted images", async () => {
  const fixture = await createLaunchpadBoundsFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    windowSize: WINDOW,
  });

  try {
    await app.window.getByRole("tab", { name: "directories" }).click();
    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();

    const composerInput = app.window.getByRole("textbox", { name: "New thread" });
    await expect(composerInput).toBeVisible();

    // Precondition: both PwrSuite cards render. If a product change drops
    // one, the crowding this spec exists to survive is gone and the gate
    // below would pass for the wrong reason.
    const cards = app.window.locator(".mcp-connection");
    await expect(cards).toHaveCount(2);

    await pastePng(composerInput, "bounds-one.png", "#3478f6");
    await expect(app.window.getByAltText("bounds-one.png")).toBeVisible();
    await pastePng(composerInput, "bounds-two.png", "#f59e0b");
    await expect(app.window.getByAltText("bounds-two.png")).toBeVisible();
    await pastePng(composerInput, "bounds-three.png", "#10b981");
    await expect(app.window.getByAltText("bounds-three.png")).toBeVisible();

    await composerInput.fill(
      ["Describe each pasted image.", "", "Then summarise them together."].join("\n"),
    );

    const startButton = app.window.getByRole("button", { name: "Start thread" });
    await expect(startButton).toBeVisible();

    const measured = await app.window.evaluate(() => {
      const clip = document.querySelector(".thread-view--launchpad");
      const composer = document.querySelector(".thread-view__launchpad-composer");
      const start = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Start thread",
      );
      if (!clip || !composer || !start) {
        return null;
      }
      const startRect = start.getBoundingClientRect();
      const hit = document.elementFromPoint(
        startRect.left + startRect.width / 2,
        startRect.top + startRect.height / 2,
      );
      const list = document.querySelector(".thread-view__connections");
      return {
        // Natural, unclipped height of each card — the cards themselves
        // keep their content height in both the broken and fixed layouts,
        // so this measures the same thing either way.
        cardHeights: [...document.querySelectorAll(".mcp-connection")].map(
          (card) => card.scrollHeight,
        ),
        listOverflowPx: list ? list.scrollHeight - list.clientHeight : null,
        clipBottom: clip.getBoundingClientRect().bottom,
        clipHeight: clip.getBoundingClientRect().height,
        composerHeight: composer.getBoundingClientRect().height,
        startBottom: startRect.bottom,
        startHitsItself: hit === start || start.contains(hit),
      };
    });

    expect(measured, "expected the launchpad, composer and send button to render").not.toBeNull();
    const {
      cardHeights,
      clipBottom,
      clipHeight,
      composerHeight,
      listOverflowPx,
      startBottom,
      startHitsItself,
    } = measured!;

    // Precondition: the scenario really is over-full. Everything the pane
    // has to hold, measured at its natural height, exceeds the pane.
    const naturalContentHeight =
      cardHeights.reduce((total, height) => total + height, 0) + composerHeight;
    expect(
      naturalContentHeight,
      `this window (${WINDOW.width}x${WINDOW.height}) is not tight enough to test anything: `
        + `${Math.round(naturalContentHeight)}px of content in a ${Math.round(clipHeight)}px pane. `
        + "Shrink the window rather than relaxing the assertions below.",
    ).toBeGreaterThan(clipHeight);

    // The gate. `.thread-view` clips with `overflow: hidden`, so anything
    // past its bottom edge is simply gone.
    expect(
      startBottom,
      `"Start thread" is ${Math.round(startBottom - clipBottom)}px below the pane's `
        + "clipped bottom edge — the operator cannot reach it by any means",
    ).toBeLessThanOrEqual(clipBottom + BOUNDS_TOLERANCE_PX);

    // Being inside the box is not the same as being clickable: a taller
    // sibling drawn over it would satisfy the bound above.
    expect(
      startHitsItself,
      "the centre of \"Start thread\" should hit the button itself",
    ).toBe(true);

    // The structural half: the cards absorb the deficit by scrolling in
    // their own list, which is the only thing in this column allowed to.
    // A refactor that lifts them back out to be siblings of the composer
    // breaks here rather than silently reintroducing the bug at some
    // window height nobody tests.
    expect(
      listOverflowPx,
      "the connection cards should live in a `.thread-view__connections` list",
    ).not.toBeNull();
    expect(
      listOverflowPx,
      "at this window the card list should be the box that scrolls",
    ).toBeGreaterThan(0);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
