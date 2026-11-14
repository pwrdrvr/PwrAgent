import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { cssRuleBody } from "../../../styles/__tests__/css-rule-body";
import { ThreadHeader } from "../ThreadHeader";
import { PROJECT_CRUMB_WHOLE_MAX_CHARS, projectCrumbFit } from "../project-crumb-fit";

afterEach(() => {
  cleanup();
});

const thread: NavigationThreadSummary = {
  id: "thread-1",
  title: "Codex fork: report content-filter blocks on the App Server protocol",
  titleSource: "explicit",
  source: "codex",
  executionMode: "default",
  updatedAt: 0,
  linkedDirectories: [],
  inbox: { inInbox: true },
};

// Printable, non-blank labels: the header renders no crumb for an empty one.
const label = fc
  .string({ minLength: 1, maxLength: 48, unit: "grapheme-ascii" })
  .filter((value) => value.trim().length > 0);

function crumbOf(projectLabel: string, linked: boolean): HTMLElement {
  render(
    <ThreadHeader
      projectLabel={projectLabel}
      project={
        linked
          ? { directoryKey: "directory:/repo", onReveal: vi.fn(), onCreateThread: vi.fn() }
          : undefined
      }
      thread={thread}
    />,
  );
  const eyebrow = linked
    ? screen.getByRole("button", { name: `Show ${projectLabel} in Directories` })
        .parentElement
    : screen.getByTitle(projectLabel);
  if (!eyebrow) throw new Error("no project eyebrow");
  return eyebrow;
}

describe("thread header project crumb fit", () => {
  // The rule the `cod…` crumb broke: a short project name is never cut,
  // whatever the title beside it. jsdom does no layout, so this pins the
  // marker and the stylesheet floors that produce the outcome in Chromium.
  it("never truncates a short name, linked or plain", () => {
    fc.assert(
      fc.property(label, fc.boolean(), (projectLabel, linked) => {
        const fit = crumbOf(projectLabel, linked).dataset.fit;
        cleanup();
        const short = Array.from(projectLabel).length <= PROJECT_CRUMB_WHOLE_MAX_CHARS;
        expect(fit).toBe(short ? "whole" : "floor");
      }),
    );
  });

  it("marks the reported project whole", () => {
    expect(crumbOf("codex", true)).toHaveAttribute("data-fit", "whole");
  });

  it("counts characters, not UTF-16 units", () => {
    expect(projectCrumbFit("🚀".repeat(PROJECT_CRUMB_WHOLE_MAX_CHARS))).toBe("whole");
  });

  it("floors each fit in the stylesheet", () => {
    expect(cssRuleBody('.thread-header__eyebrow[data-fit="whole"]')).toMatch(
      /min-width:\s*max-content/,
    );
    // A floor narrower than every floored name, so a cut always hides
    // several characters, never just the two or three an ellipsis replaces.
    const floor = cssRuleBody('.thread-header__eyebrow[data-fit="floor"]').match(
      /min-width:\s*(\d+)ch/,
    );
    expect(Number(floor?.[1])).toBeLessThanOrEqual(PROJECT_CRUMB_WHOLE_MAX_CHARS - 6);
    expect(Number(floor?.[1])).toBeGreaterThanOrEqual(10);
  });
});
