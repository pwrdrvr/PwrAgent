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
 * outline. The scroller records how focus arrived (`data-focus-origin`),
 * and app.css rings it only when it arrived by keyboard: a click and a
 * keystroke draw nothing, and Tab draws the house ring, since a Tab stop
 * that shows nothing fails WCAG 2.4.7. This pins both halves.
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

test("keystroke after clicking the transcript draws no outline, Tab draws the ring", async () => {
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
      };
    });
    expect(focusState).not.toBeNull();
    // Focus itself must stay (keyboard scrolling depends on it) — only
    // the viewport-sized ring goes. A `none` style paints nothing; the
    // computed width is no evidence either way, since Chromium 152
    // (Electron 44) reports the `medium` 3px there where 146 reported 0px.
    expect(focusState?.focused).toBe(true);
    expect(focusState?.outlineStyle).toBe("none");

    // Come back by keyboard: this arrival is a Tab stop, and it draws the
    // ring. Tab in from a throwaway stop placed directly before the
    // scroller, so the arrival does not depend on which header controls
    // precede it — Shift+Tab then Tab left the scroller unfocused on
    // macOS CI only.
    await window.evaluate(() => {
      const items = document.querySelector(".transcript-list__items");
      const sentinel = document.createElement("div");
      sentinel.className = "e2e-tab-sentinel";
      sentinel.tabIndex = 0;
      items?.before(sentinel);
      sentinel.focus();
    });
    await window.keyboard.press("Tab");
    const tabbedState = await window.evaluate(() => {
      const items = document.querySelector(".transcript-list__items");
      if (!items) return null;
      const active = document.activeElement;
      const style = getComputedStyle(items);
      document.querySelector(".e2e-tab-sentinel")?.remove();
      return {
        active: active ? `${active.tagName.toLowerCase()}.${active.className}` : "none",
        ring: {
          focused: items === active,
          outlineColor: style.outlineColor,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        },
      };
    });
    expect(tabbedState).not.toBeNull();
    expect(tabbedState?.ring, `Tab focused ${tabbedState?.active}`).toEqual({
      focused: true,
      outlineColor: "rgb(255, 138, 31)",
      outlineStyle: "solid",
      outlineWidth: "2px",
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
