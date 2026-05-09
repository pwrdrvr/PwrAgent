import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

/**
 * Issue #240 follow-up — covers the composer's height-growth contract:
 *
 *   - Empty composer is compact (~56px tall) so the transcript above
 *     keeps as much reading area as possible.
 *   - Typing more lines grows the composer.
 *   - The wrapper clamps at the 280px max — beyond that the inner
 *     editor scrolls inside the wrapper.
 *
 * Without these tests, a CSS edit that lifts `min-height` back to 144
 * (steals reading area) or removes the `max-height: 280px` cap (pushes
 * the picker rows off-screen on shorter viewports) would land
 * silently. The theme-contract unit test locks the CSS values; this
 * E2E verifies the values produce the intended rendered behavior.
 */

async function createComposerHeightFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "pwragent-composer-height-"),
  );
  const fixturePath = path.join(rootDir, "composer-height.fixture.json");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "composer-height-growth",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: { name: "Replay Codex", version: "1.0.0" },
              methods: ["thread/list", "thread/read", "skills/list", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-height",
                title: "Composer height growth",
                titleSource: "explicit",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                updatedAt: 1_000,
              },
            ],
          },
          {
            id: "thread-read-height",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "intro-message",
                  role: "assistant",
                  text: "Tell me anything.",
                },
              ],
              messages: [
                {
                  id: "intro-message",
                  role: "assistant",
                  text: "Tell me anything.",
                },
              ],
              lastAssistantMessage: "Tell me anything.",
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

const COMPOSER_MIN_HEIGHT = 56;
const COMPOSER_MAX_HEIGHT = 280;

// `box-sizing: border-box` is the renderer-wide default, so the
// wrapper's `getBoundingClientRect().height` matches the
// `min-height` / `max-height` values directly (the 1px top + bottom
// borders are inside the box). 2px tolerance covers sub-pixel
// rendering rounding on HiDPI displays and is tight enough to catch
// any silent regression that nudges the floor / cap by more than a
// few pixels.
const HEIGHT_TOLERANCE_PX = 2;

// How much extra above the floor counts as "still compact" — small
// enough that a regression bumping `min-height` past 64px would
// fail this assertion. Larger than HEIGHT_TOLERANCE_PX because the
// floor includes the wrapper border + a single line of input that
// renders slightly taller than 56 if the line-height rounds up.
const EMPTY_FLOOR_SLACK_PX = 8;

test("composer is compact when empty, grows with content, clamps at max-height", async () => {
  const fixture = await createComposerHeightFixture();
  // Defensive cleanup: `launchElectronApp` can throw before the
  // `try` block enters its scope (Electron startup, fixture-replay
  // initialize step, etc.). Without an outer try/finally around the
  // app launch, a launch failure would leak the fixture's tmp dir.
  try {
    const app = await launchElectronApp({
      fixturePath: fixture.fixturePath,
    });

    try {
      await app.window
        .getByRole("button", { name: /Composer height growth/i })
        .first()
        .click();
      await expect(
        app.window.getByRole("heading", {
          level: 2,
          name: "Composer height growth",
        }),
      ).toBeVisible();

      const composerWrapper = app.window.locator(".composer-tiptap-input");
      await expect(composerWrapper).toBeVisible();

      // ---- Empty state ----
      const emptyHeight = (await composerWrapper.boundingBox())?.height ?? 0;
      expect(
        emptyHeight,
        "empty composer should sit at the compact min-height floor",
      ).toBeGreaterThanOrEqual(COMPOSER_MIN_HEIGHT - HEIGHT_TOLERANCE_PX);
      expect(
        emptyHeight,
        "empty composer should not balloon past the floor before any input",
      ).toBeLessThanOrEqual(COMPOSER_MIN_HEIGHT + EMPTY_FLOOR_SLACK_PX);

      // ---- A few lines fits inside the cap and grows the wrapper ----
      const reply = app.window.getByRole("textbox", { name: "Reply" });
      const shortDraft = ["one", "two", "three", "four", "five"].join("\n");
      await reply.fill(shortDraft);

      const grownHeight = (await composerWrapper.boundingBox())?.height ?? 0;
      expect(
        grownHeight,
        "five-line draft should grow the composer wrapper above the empty floor",
      ).toBeGreaterThan(emptyHeight + 16);
      expect(
        grownHeight,
        "five-line draft should still fit inside the max-height cap",
      ).toBeLessThanOrEqual(COMPOSER_MAX_HEIGHT + HEIGHT_TOLERANCE_PX);

      // ---- Many lines clamp at the cap (overflow scrolls the editor) ----
      const tallDraft = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join(
        "\n",
      );
      await reply.fill(tallDraft);

      const clampedHeight = (await composerWrapper.boundingBox())?.height ?? 0;
      expect(
        clampedHeight,
        "40-line draft should clamp at the wrapper's max-height (no off-screen growth)",
      ).toBeLessThanOrEqual(COMPOSER_MAX_HEIGHT + HEIGHT_TOLERANCE_PX);
      // And the wrapper should be near the cap (not stuck at a smaller
      // height) — the editor inside should be the part that scrolls.
      expect(
        clampedHeight,
        "40-line draft should push the wrapper to the max-height cap",
      ).toBeGreaterThanOrEqual(COMPOSER_MAX_HEIGHT - HEIGHT_TOLERANCE_PX);

      // ---- Clearing returns the wrapper to the compact floor ----
      await reply.fill("");
      const clearedHeight = (await composerWrapper.boundingBox())?.height ?? 0;
      expect(
        clearedHeight,
        "clearing the draft should collapse the composer back to the floor",
      ).toBeLessThanOrEqual(COMPOSER_MIN_HEIGHT + EMPTY_FLOOR_SLACK_PX);
    } finally {
      await app.close();
    }
  } finally {
    await fixture.cleanup();
  }
});
