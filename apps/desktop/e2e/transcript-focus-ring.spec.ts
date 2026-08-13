import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

/**
 * The transcript scroller is tabIndex=0 so keyboard users can scroll it
 * (axe scrollable-region-focusable). Chromium promotes a click-focused
 * element to :focus-visible on the next keystroke, which used to draw
 * the OS-accent UA focus ring around the ENTIRE transcript — click any
 * transcript text, press an arrow key, and the whole pane grew an
 * outline. app.css now suppresses the outline on the scroller; this
 * pins the repro so the UA ring can't come back.
 */

async function createTranscriptFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "pwragent-transcript-focus-ring-"),
  );
  const fixturePath = path.join(rootDir, "transcript-focus-ring.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify({
      metadata: { backend: "codex", scenario: "transcript-focus-ring" },
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
              id: "thread-focus-1",
              title: "Focus ring thread",
              titleSource: "explicit",
              source: "codex",
              executionMode: "default",
              linkedDirectories: [],
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
                id: "message-1",
                role: "assistant",
                text: "Transcript body for the focus ring check.",
              },
            ],
            messages: [
              {
                id: "message-1",
                role: "assistant",
                text: "Transcript body for the focus ring check.",
              },
            ],
            lastAssistantMessage: "Transcript body for the focus ring check.",
            pagination: { supportsPagination: false, hasPreviousPage: false },
          },
        },
      ],
    }),
  );
  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    fixturePath,
  };
}

test("keystroke after clicking the transcript draws no outline around it", async () => {
  const fixture = await createTranscriptFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });
  try {
    const { window } = app;
    // The title is click-through since the transcript-gaps pass (pointer
    // events fall to the open-thread overlay button), so target the
    // button by its accessible name.
    await window.getByRole("button", { name: "Focus ring thread" }).click();
    const body = window.getByText("Transcript body for the focus ring check.");
    await expect(body).toBeVisible();

    // Click focuses the tabIndex=0 scroller; the next keystroke promotes
    // it to :focus-visible — the exact sequence that used to ring it.
    await body.click();
    await window.keyboard.press("ArrowDown");

    const focusState = await window.evaluate(() => {
      const items = document.querySelector(".transcript-list__items");
      if (!items) return null;
      const style = getComputedStyle(items);
      return {
        focused: items === document.activeElement,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    expect(focusState).not.toBeNull();
    // Focus itself must stay (keyboard scrolling depends on it) — only
    // the viewport-sized ring goes.
    expect(focusState?.focused).toBe(true);
    expect(focusState?.outlineStyle).toBe("none");
    expect(focusState?.outlineWidth).toBe("0px");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
