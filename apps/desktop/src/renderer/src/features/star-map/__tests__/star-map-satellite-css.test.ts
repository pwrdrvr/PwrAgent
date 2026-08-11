import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHAT_CARD_CONTEXT_SPINE_WIDTH,
  CHAT_CARD_CONTEXT_WIDTH,
  dockContextRect,
} from "../star-map-chat-card-geometry";

/**
 * The satellite context card hosts ThreadContextPanel, whose geometry is
 * governed by CSS the component tests cannot see — jsdom loads no
 * stylesheet, which is exactly how "panel falls back to 380px in a 300px
 * card" and "the rail's 32px peek margin squeezes out the tab spine"
 * both shipped past a green suite. These assertions read app.css the way
 * star-map-z-layers.test.ts does, so the contract at least cannot
 * silently disappear.
 */
const CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../styles/app.css",
  ),
  "utf8",
);

describe("satellite context card CSS contract", () => {
  it("lets the rail fill the card, overriding its thread-view peek margin", () => {
    // .context-rail caps itself at calc(100% - 32px) so the thread view
    // keeps a hover-peek gutter. The satellite card is sized to
    // panel + spine EXACTLY, so that cap left a 32px dead strip on the
    // left and pushed the tab spine past the card's clip on the right.
    expect(
      /\.star-map-satellite-card__body \.context-rail \{[^}]*max-width:\s*100%/.test(
        CSS,
      ),
    ).toBe(true);
  });

  it("keeps the spine constant in sync with the rail's spine width", () => {
    const spine = /\.context-rail__spine \{[^}]*flex: 0 0 (\d+)px/.exec(CSS);
    expect(spine).not.toBeNull();
    expect(Number(spine![1])).toBe(CHAT_CARD_CONTEXT_SPINE_WIDTH);
  });

  it("sizes the dock rect for both rail columns", () => {
    const rect = dockContextRect({ left: 0, top: 0, width: 420, height: 520 });
    expect(rect.width).toBe(
      CHAT_CARD_CONTEXT_WIDTH + CHAT_CARD_CONTEXT_SPINE_WIDTH,
    );
  });
});
