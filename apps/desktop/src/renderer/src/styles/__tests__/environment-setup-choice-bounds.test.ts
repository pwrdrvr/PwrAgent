import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Locks the declarations that keep the environment-setup failure panel from
 * eating the chat column.
 *
 * The bug this exists to prevent: `.environment-setup-choice` renders as a
 * sibling of the transcript inside `.thread-view__primary`, and a flex item's
 * `min-height: auto` floor sized it to its own content. Measured in headless
 * Chromium against this stylesheet, the panel was 685px tall inside a 644px
 * pane at a 700px-tall window — the same 685px at every window height. Two
 * things followed: the transcript was handed 0px of height, so there was
 * nothing left to scroll, and the actions row landed 53px below the
 * `overflow: hidden` on `.thread-view`, so "Continue anyway" could not be
 * reached by any means. The operator could neither dismiss the panel nor
 * scroll past it.
 *
 * jsdom does no layout, so the invariant is pinned in the stylesheet here.
 * The structural half of the fix — that the actions row is a sibling of the
 * scrolling body rather than a child of it — is asserted against the rendered
 * DOM in `thread-view.test.tsx`, which is where a refactor would break it.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

/** Body of the first top-level CSS rule whose selector matches exactly. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`),
  );
  if (!match?.groups?.body) {
    throw new Error(`Expected app.css to define ${selector}`);
  }
  return match.groups.body;
}

describe("environment setup failure panel bounds", () => {
  it("keeps the pane that clips the panel clipped", () => {
    // The subject of the whole fix: `.thread-view` shows no scrollbar, so
    // anything pushed past its bottom edge is simply gone. If this ever
    // becomes a scroll container the assertions below have lost their
    // reason and should be revisited, not deleted.
    expect(ruleBody(".thread-view")).toMatch(/overflow:\s*hidden;/);
  });

  it("lets the panel shrink below its own content", () => {
    // Without this the panel keeps its content height no matter how short
    // the window is, and the transcript below it absorbs the whole deficit.
    expect(ruleBody(".environment-setup-choice")).toMatch(/min-height:\s*0/);
  });

  it("bounds the panel's height on the body and scrolls the overflow there", () => {
    const body = ruleBody(".environment-setup-choice__body");
    // The bound has to sit on the body, not the section: under ~1200px of
    // chat column the actions row wraps onto a second flex line, and a
    // wrapped line is sized to its content — capping the section would clip
    // the buttons rather than shrink the body.
    expect(body).toMatch(/max-height:\s*\d+vh/);
    // A bound with no scroller just moves the clip inside the panel.
    expect(body).toMatch(/overflow-y:\s*auto/);
    // `overflow-y: auto` alone still cannot shrink past the content floor.
    expect(body).toMatch(/min-height:\s*0/);
  });

  it("leaves the panel's bound relative to the window, not the section", () => {
    // A percentage here resolves against the section's `auto` height, which
    // means it does not resolve at all and the bound silently disappears.
    expect(ruleBody(".environment-setup-choice__body")).not.toMatch(
      /max-height:\s*\d+%/,
    );
  });

  it("keeps the command output out of a second nested scroller", () => {
    // The output pre used to cap itself at 320px. Inside a body that is
    // itself shorter than 320px on a small window, that is two stacked
    // vertical scrollers for one block of text, and the wheel has to chain
    // out of the inner one to reach the rest of the panel.
    expect(ruleBody(".environment-setup-choice__pre--output")).not.toMatch(
      /max-height:/,
    );
  });
});
