import fc from "fast-check";
import { expect, it } from "vitest";
import { normalizeQueuedMessageTitle } from "../app-server/queued-message-title";

it("preserves a complete PR number that fits before punctuation", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 999_999 }),
    fc.constantFrom(",", ";", ":", "!", "。"),
    fc.integer({ min: 97, max: 100 }),
    (prNumber, punctuation, length) => {
      const reference = ` PR ${prNumber}`;
      const prefix = `${"a".repeat(length - reference.length)}${reference}`;
      expect(normalizeQueuedMessageTitle({ title: `${prefix}${punctuation} then archive` }))
        .toBe(prefix);
    },
  ));
});

it("preserves titles that fit the code-point budget even with astral characters", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom("🚀", "🧪", "📦"), { minLength: 1, maxLength: 12 }),
    (emoji) => {
      const title = `${emoji.join("")} ${"a".repeat(94 - emoji.length)} done`;
      expect(normalizeQueuedMessageTitle({ title })).toBe(title);
    },
  ));
});
