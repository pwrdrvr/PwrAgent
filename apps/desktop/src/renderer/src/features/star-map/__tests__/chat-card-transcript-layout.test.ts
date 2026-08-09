import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  path.resolve(testDir, "../../../styles/app.css"),
  "utf8",
);

function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`app.css has no rule for ${selector}`);
  return match[0];
}

/**
 * The chat card's transcript box must NOT be a scroll container.
 *
 * TranscriptList owns a scroller (`.transcript-list__items`) and writes
 * scroll position, glue-to-bottom, and its load-older trigger against it.
 * That box only becomes a scroller when every ancestor down to it is a
 * flex column that can shrink; give the card's wrapper its own overflow
 * instead and the items box grows to full content height, so the writes
 * land on an element that cannot scroll and silently do nothing — the card
 * opens at the oldest message and never follows or pages.
 *
 * jsdom does no layout, so nothing else in the suite can catch this.
 */
describe("star map chat card transcript layout", () => {
  const rule = ruleFor(".star-map-chat-card__transcript");

  it("is a flex column so the transcript's own scroller resolves", () => {
    expect(rule).toMatch(/display:\s*flex;/);
    expect(rule).toMatch(/flex-direction:\s*column;/);
  });

  it("can shrink below its content", () => {
    // Without this the items box never has a bounded height to scroll in.
    expect(rule).toMatch(/min-height:\s*0;/);
  });

  it("does not take the overflow for itself", () => {
    expect(rule).not.toMatch(/overflow[^:]*:\s*[^;]*(auto|scroll)/);
  });
});
