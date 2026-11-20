import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { cssRuleBody } from "../../../styles/__tests__/css-rule-body";
import { ThreadHeader } from "../ThreadHeader";
import { ThreadPlaceholderHeader } from "../ThreadPlaceholderHeader";
import {
  PROJECT_CRUMB_WHOLE_MAX_CHARS,
  projectCrumbColumns,
  projectCrumbFit,
} from "../project-crumb-fit";

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

// Non-blank labels from Latin, CJK and emoji: the header renders no crumb
// for an empty one, and wide characters count double.
const character = fc.oneof(
  fc.string({ minLength: 1, maxLength: 1, unit: "grapheme-ascii" }),
  fc.constantFrom("项", "目", "ｃ", "한", "🚀", "é"),
);
const label = fc
  .array(character, { minLength: 1, maxLength: 32 })
  .map((parts) => parts.join(""))
  .filter((value) => value.trim().length > 0);

// Independent oracle for the column count: the fixed wide samples above.
const WIDE_SAMPLES = new Set(["项", "目", "ｃ", "한", "🚀"]);
function oracleColumns(value: string): number {
  return Array.from(value).reduce((sum, ch) => sum + (WIDE_SAMPLES.has(ch) ? 2 : 1), 0);
}

function crumbOf(projectLabel: string, linked: boolean): HTMLElement {
  const { container } = render(
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
  // By class, not accessible name: Testing Library trims and collapses the
  // whitespace an arbitrary label may carry.
  const eyebrow = container.querySelector<HTMLElement>(".thread-header__eyebrow");
  // The linked crumb really is the link's eyebrow, not a plain label.
  expect(eyebrow?.querySelector("button") !== null).toBe(linked);
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
        const short = oracleColumns(projectLabel) <= PROJECT_CRUMB_WHOLE_MAX_CHARS;
        expect(fit).toBe(short ? "whole" : "floor");
      }),
    );
  });

  it("marks the reported project whole", () => {
    expect(crumbOf("codex", true)).toHaveAttribute("data-fit", "whole");
  });

  it("counts characters, not UTF-16 units, and wide ones double", () => {
    expect(projectCrumbColumns("é".repeat(PROJECT_CRUMB_WHOLE_MAX_CHARS))).toBe(
      PROJECT_CRUMB_WHOLE_MAX_CHARS,
    );
    const half = PROJECT_CRUMB_WHOLE_MAX_CHARS / 2;
    expect(projectCrumbFit("🚀".repeat(half))).toBe("whole");
    expect(projectCrumbFit("项".repeat(half + 1))).toBe("floor");
  });

  it("marks the loading placeholder's crumb the same way", () => {
    render(
      <ThreadPlaceholderHeader projectLabel="codex" title="Loading a long thread title" />,
    );
    expect(screen.getByTitle("codex")).toHaveAttribute("data-fit", "whole");
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
