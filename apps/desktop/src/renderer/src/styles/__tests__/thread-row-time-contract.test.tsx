import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { ThreadRow } from "../../features/navigation/ThreadRow";

/**
 * A sidebar thread row's timestamp must occupy exactly one line.
 *
 * Under seven days the label is a single token ("now", "42m", "3h", "6d")
 * and nothing can break it. At seven days it switches to an absolute date
 * — "Aug 8" — which carries a space, and `.thread-row__time` was a plain
 * flex item: shrinkable (default `flex-shrink: 1`, and `min-width: auto`
 * resolves to the min-content width, i.e. "Aug") and wrappable. In a
 * narrow sidebar the title's ellipsis is not the only thing that gives —
 * the date wraps to two lines and the row grows a blank line under the
 * title while every younger row beside it stays one line tall.
 *
 * Wrapping is a layout outcome and jsdom does not lay out CSS, so this
 * asserts the halves separately: render tests that the ≥7-day label is the
 * absolute date and that the date is breakable text (the precondition — if
 * the format ever became one token the CSS assertions would be measuring
 * nothing), then the declarations that keep the flex item from shrinking
 * or breaking.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

/** Body of the first top-level CSS rule whose selector matches exactly. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`)
  );
  if (!match?.groups?.body) {
    throw new Error(`Expected app.css to define ${selector}`);
  }
  return match.groups.body;
}

function declaration(body: string, property: string): string | undefined {
  const match = body.match(
    new RegExp(`(?:^|\\n)\\s*${property}:\\s*(?<value>[^;]+);`)
  );
  return match?.groups?.value.trim();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The shape ThreadRow's own module-level formatter is built with. */
const ABSOLUTE_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
};

const baseThread: NavigationThreadSummary = {
  id: "thread-time",
  title: "A thread title long enough that the sidebar has to ellipsize it",
  titleSource: "explicit",
  summary: "Test row for the timestamp line contract",
  source: "codex",
  executionMode: "default",
  updatedAt: Date.now(),
  inbox: { inInbox: false },
  linkedDirectories: [],
};

function renderTime(updatedAt: number): string {
  const { container } = render(
    <ThreadRow
      thread={{ ...baseThread, updatedAt }}
      onOpenContextMenu={vi.fn()}
      onSelectThread={vi.fn()}
    />
  );
  const time = container.querySelector(".thread-row__time");
  if (!time) {
    throw new Error("Expected the row to render a .thread-row__time element");
  }
  return time.textContent ?? "";
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("thread row timestamp line contract", () => {
  it("switches to an absolute date once a thread ages past a week", () => {
    const updatedAt = Date.now() - 30 * DAY_MS;

    // Deliberately compared against the machine's own locale, the way the
    // row formats it — the claim is "past a week the label is the absolute
    // date", not what that date looks like here.
    expect(renderTime(updatedAt)).toBe(
      new Intl.DateTimeFormat(undefined, ABSOLUTE_DATE_OPTIONS).format(updatedAt)
    );
  });

  it("formats that date as text a line break can split", () => {
    // The precondition the CSS below exists for, pinned to en-US rather
    // than read off the row: the row formats in the OPERATOR's locale, and
    // asserting breakability against the test machine's `LANG` would fail
    // on a ja-JP or zh-CN box, where the same options render "8月8日" with
    // nothing to break. The wrap is real wherever the date has a space,
    // which is most locales, so the rule below is not en-US-only.
    expect(
      new Intl.DateTimeFormat("en-US", ABSOLUTE_DATE_OPTIONS).format(
        Date.now() - 30 * DAY_MS
      )
    ).toMatch(/\s/);
  });

  it("renders single-token relative labels while a thread is younger", () => {
    // Sanity: nothing under a week can wrap on its own, so a regression
    // here is only ever visible on older rows.
    expect(renderTime(Date.now() - 3 * DAY_MS)).not.toMatch(/\s/);
    expect(renderTime(Date.now() - 90 * 60 * 1000)).not.toMatch(/\s/);
  });

  it("never breaks the timestamp across lines", () => {
    expect(declaration(ruleBody(".thread-row__time"), "white-space")).toBe(
      "nowrap"
    );
  });

  it("makes the title, not the timestamp, absorb a narrow sidebar", () => {
    // `.thread-row__heading` is `flex: 1 1 auto` with `min-width: 0` and an
    // ellipsized title, so it can give up space without changing height.
    // The timestamp cannot: shrinking it below its content width is what
    // forces the break, so it stays out of the negotiation entirely.
    expect(declaration(ruleBody(".thread-row__time"), "flex")).toBe("0 0 auto");
  });
});
