import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

/**
 * Measures where the composer's inline mention chips actually land, which
 * the CSS contract test in
 * `src/renderer/src/styles/__tests__/composer-chip-alignment.test.ts`
 * cannot: jsdom does not lay out CSS, so that test can only assert the
 * declarations the alignment depends on.
 *
 * The chips are inline-flex, and an inline-flex box takes its baseline from
 * its FIRST flex item. The kinds disagree on what that is — the `$skill`
 * chip leads with its label text, `#thread` leads with a 1em SVG icon — so
 * before the `::before` strut they aligned from different origins.
 *
 * Measured on this fixture at this window size, with the fix and with it
 * reverted:
 *
 *              chip top vs its line's text top      paragraph height
 *   fixed      skill -0.95   thread -0.95  (0.00)   44.78 = 2 x 22.39
 *   reverted   skill -2.77   thread -4.25  (1.48)   47.80 (+3.02)
 *
 * Hence the 0.5px and 1px tolerances below: roughly three times the
 * observed spread in the passing state, and roughly a third of the
 * regression they exist to catch.
 *
 * Coverage note: this drives the two autocompletes that need no fixture
 * work, which is also the pair that was furthest apart. The PR pill (a
 * third structure, leading with an 8px dot) is not covered — its `#`
 * autocomplete entry only appears for a numeric query against a thread
 * carrying an attached PR, and no E2E fixture seeds one today.
 */
const specDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  specDir,
  "fixtures/skill-autocomplete-interactions/replay.fixture.json",
);

/** Chips must agree this closely on where they sit within their line. */
const OFFSET_TOLERANCE_PX = 0.5;
/** Slack for the line-grid and chip-height comparisons. */
const HEIGHT_TOLERANCE_PX = 1;

type ChipPlacement = {
  height: number;
  kind: string;
  /** Chip top edge relative to the top of its own line's text. */
  offsetInLine: number;
};

type ComposerMetrics = {
  height: number;
  /** Rendered lines, counted from the paragraph's own text runs. */
  lines: number;
  chips: ChipPlacement[];
};

/**
 * Line count and per-chip placement in one pass.
 *
 * Every reference comes from the paragraph's TEXT runs, never from a chip's
 * own box. That distinction is the whole measurement: a chip that rides too
 * high also drags the top of its line box up with it, so measuring a chip
 * against its line box compares it to itself and reports zero no matter how
 * misaligned it is. A text run sits on the baseline, so its box top is a
 * fixed reference the chip can be wrong against.
 */
async function composerMetrics(paragraph: Locator): Promise<ComposerMetrics> {
  return await paragraph.evaluate((element) => {
    const textTops: number[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement;
      if (owner?.closest(".composer-tiptap-input__mention")) {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.height > 0) {
          textTops.push(rect.top);
        }
      }
    }

    // One line contributes a top per text run, all equal; 1px absorbs
    // sub-pixel noise without merging lines a whole line-height apart.
    const sorted = [...textTops].sort((left, right) => left - right);
    const lineTops = sorted.filter(
      (top, index) => index === 0 || top - sorted[index - 1] > 1,
    );

    const chips = [
      ...element.querySelectorAll<HTMLElement>(".composer-tiptap-input__mention"),
    ].map((chip) => {
      const box = chip.getBoundingClientRect();
      const centre = (box.top + box.bottom) / 2;
      const nearest = lineTops.reduce(
        (best, top) =>
          Math.abs(top - centre) < Math.abs(best - centre) ? top : best,
        lineTops[0] ?? box.top,
      );
      return {
        height: box.height,
        kind: chip.getAttribute("data-mention-kind") ?? "skill",
        offsetInLine: box.top - nearest,
      };
    });

    return {
      chips,
      height: element.getBoundingClientRect().height,
      lines: Math.max(lineTops.length, 1),
    };
  });
}

test("composer chips of every structure sit at one height in the prose", async () => {
  const app = await launchElectronApp({
    fixturePath,
    windowSize: {
      width: 1180,
      height: 760,
    },
  });

  try {
    await app.window
      .getByRole("button", { name: /Skill autocomplete replay/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Skill autocomplete replay",
      }),
    ).toBeVisible();

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "Reply" });
    const paragraph = tiptapInput.locator(".composer-tiptap-input__editor > p");

    // Baseline: plain prose, before any chip interrupts it. Typed rather
    // than filled so the caret is left at the end of the draft without
    // depending on where `fill()` parks it in a contenteditable.
    await textbox.click();
    await app.window.keyboard.type("Run");
    await expect(tiptapInput).toHaveAttribute("data-value", "Run");
    const plain = await composerMetrics(paragraph);
    expect(plain.lines).toBe(1);
    const plainLineHeight = plain.height;

    // `$skill` — a chip whose first flex item is its label text.
    await app.window.keyboard.type(" $ce:plan");
    await expect(app.window.getByRole("listbox", { name: "Skills" })).toBeVisible();
    await app.window.keyboard.press("Enter");
    await expect(app.window.getByRole("listbox", { name: "Skills" })).toBeHidden();

    // `#thread` — a chip whose first flex item is a 1em SVG icon. The
    // trailing word matters: the composer is 342px wide here, so the draft
    // wraps and this keeps a text run on the second line for that chip to
    // be measured against.
    await app.window.keyboard.type("on #");
    const hashOptions = app.window.getByRole("listbox", {
      name: "Threads and pull requests",
    });
    await expect(hashOptions).toBeVisible();
    await app.window.keyboard.press("Enter");
    await expect(hashOptions).toBeHidden();
    await app.window.keyboard.type("today");

    const skillChip = tiptapInput.locator(
      ".composer-tiptap-input__mention:not([data-mention-kind])",
    );
    const threadChip = tiptapInput.locator(
      '.composer-tiptap-input__mention[data-mention-kind="thread"]',
    );
    await expect(skillChip).toHaveCount(1);
    await expect(threadChip).toHaveCount(1);

    // Guard against a vacuous pass: the whole point is that these two chips
    // lead with different elements, so if the thread chip ever stops
    // rendering its icon there is nothing left to disagree about and the
    // comparison below proves nothing.
    expect(
      await skillChip.evaluate((element) => element.firstElementChild?.tagName ?? null),
    ).toBeNull();
    expect(
      await threadChip.evaluate((element) =>
        element.firstElementChild?.tagName.toLowerCase() ?? null,
      ),
    ).toBe("svg");

    const chipped = await composerMetrics(paragraph);
    expect(chipped.chips).toHaveLength(2);
    const [first, ...rest] = chipped.chips;

    for (const placement of rest) {
      expect(
        Math.abs(placement.offsetInLine - first.offsetInLine),
        `${placement.kind} chip vs ${first.kind} chip, top edge within its own line`,
      ).toBeLessThanOrEqual(OFFSET_TOLERANCE_PX);
      expect(Math.abs(placement.height - first.height)).toBeLessThanOrEqual(
        HEIGHT_TOLERANCE_PX,
      );
    }

    // And no chip pushes its line taller than plain prose. Compared as a
    // total against the expected total rather than as an average per line:
    // the chips land on different lines here, and an average halves
    // whatever any one of them contributes.
    expect(
      Math.abs(chipped.height - chipped.lines * plainLineHeight),
      `${chipped.lines} lines of ${plainLineHeight}px`,
    ).toBeLessThanOrEqual(HEIGHT_TOLERANCE_PX);
  } finally {
    await app.close();
  }
});
