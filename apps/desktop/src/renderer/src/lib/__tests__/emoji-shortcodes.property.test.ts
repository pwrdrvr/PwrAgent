import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildReactionEmojiCatalog } from "../../features/navigation/reaction-emoji-catalog";
import {
  LABEL_LETTER_REACTIONS,
  LABEL_NUMBER_REACTIONS,
  QUICK_REACTIONS,
} from "../../features/navigation/reaction-picker-model";
import {
  findEmojiShortcodeTrigger,
  findExactEmojiShortcodeBeforeColon,
  hasPotentialEmojiShortcode,
  isInsideUnclosedCodeContext,
  replaceEmojiShortcodesInText,
  resolveEmojiShortcode,
  searchEmojiShortcodes,
} from "../emoji-shortcodes";

const catalog = buildReactionEmojiCatalog();

const KNOWN_SHORTCODES = [
  { code: "+1", emoji: "👍" },
  { code: "-1", emoji: "👎" },
  { code: "thumbsup", emoji: "👍" },
  { code: "thumbs_up", emoji: "👍" },
  { code: "rocket", emoji: "🚀" },
  { code: "tada", emoji: "🎉" },
  { code: "fire", emoji: "🔥" },
  { code: "heart", emoji: "❤️" },
  { code: "white_check_mark", emoji: "✅" },
  { code: "avocado", emoji: "🥑" },
  { code: "unicorn", emoji: "🦄" },
  { code: "100", emoji: "💯" },
  { code: "zap", emoji: "⚡" },
] as const;

describe("emoji shortcode catalog lookup", () => {
  it("resolves every quick, label, and Unicode catalog shortcode", () => {
    for (const entry of [
      ...QUICK_REACTIONS,
      ...LABEL_NUMBER_REACTIONS,
      ...LABEL_LETTER_REACTIONS,
    ]) {
      const resolved = resolveEmojiShortcode(entry.shortcode, catalog);
      expect(resolved?.emoji, `:${entry.shortcode}:`).toBe(entry.emoji);
    }

    for (const { code, emoji } of KNOWN_SHORTCODES) {
      expect(resolveEmojiShortcode(code, catalog)?.emoji, `:${code}:`).toBe(emoji);
      expect(resolveEmojiShortcode(code.toUpperCase(), catalog)?.emoji, `:${code.toUpperCase()}:`).toBe(emoji);
    }
  });

  it("ranks expected matches first for autocomplete queries", () => {
    expect(searchEmojiShortcodes("+1", catalog)[0]?.emoji).toBe("👍");
    expect(searchEmojiShortcodes("thumbs", catalog)[0]?.emoji).toBe("👍");
    expect(searchEmojiShortcodes("rocket", catalog)[0]?.emoji).toBe("🚀");
    expect(searchEmojiShortcodes("avocado", catalog)[0]?.emoji).toBe("🥑");
    expect(searchEmojiShortcodes("_", catalog)).toEqual([]);
    expect(searchEmojiShortcodes("--", catalog)).toEqual([]);
  });
});

describe("emoji shortcode boundary safety properties", () => {
  const knownArbitrary = fc.constantFrom(...KNOWN_SHORTCODES);
  const proseWord = fc.stringMatching(/^[a-z]{1,8}$/);
  const unknownShortcode = fc
    .stringMatching(/^zz_[a-z0-9]{2,12}$/)
    .filter((code) => resolveEmojiShortcode(code, catalog) === undefined);

  it("expands known shortcodes at valid prose boundaries and agrees with composer auto-expansion", () => {
    fc.assert(
      fc.property(
        proseWord,
        proseWord,
        knownArbitrary,
        fc.constantFrom(" ", "\n", " ("),
        fc.constantFrom("", " ", ".", ",", "!", "?", ";", ")"),
        (before, after, known, leadSep, trailPunct) => {
          const suffix = trailPunct === "" ? "" : `${trailPunct} ${after}`;
          const prefix = `${before}${leadSep}:${known.code}`;
          const full = `${prefix}:${suffix}`;

          const proseExpanded = replaceEmojiShortcodesInText(full, { catalog });
          const composerMatch = findExactEmojiShortcodeBeforeColon(prefix, suffix, { catalog });

          expect(composerMatch?.entry.emoji).toBe(known.emoji);
          const composerExpanded = composerMatch
            ? `${prefix.slice(0, composerMatch.start)}${composerMatch.entry.emoji}${suffix}`
            : full;

          expect(proseExpanded).toBe(`${before}${leadSep}${known.emoji}${suffix}`);
          expect(proseExpanded).toBe(composerExpanded);
        },
      ),
    );
  });

  it("never expands unknown :shortcode: tokens", () => {
    fc.assert(
      fc.property(proseWord, unknownShortcode, proseWord, (before, code, after) => {
        const text = `${before} :${code}: ${after}`;
        expect(replaceEmojiShortcodesInText(text, { catalog })).toBe(text);
        expect(
          findExactEmojiShortcodeBeforeColon(`${before} :${code}`, ` ${after}`, { catalog }),
        ).toBeUndefined();
      }),
    );
  });

  it("never expands non-boundary colons, :: operators, timestamps, slices, or URLs even with known shortcodes", () => {
    fc.assert(
      fc.property(proseWord, knownArbitrary, proseWord, (left, known, right) => {
        const nonBoundaryCases = [
          `${left}:${known.code}:${right}`,
          `${left}::${known.code}`,
          `::${known.code}::`,
          `:${known.code}::${right}`,
          `${left}::${known.code}:`,
          `https://example.com/:${known.code}:/${right}`,
          `http://localhost:8080/${known.code}:1`,
          `${left}[:${known.code}:]`,
          `${left}(:${known.code}:)`,
          `12:30:00`,
          `std::vector`,
          `foo:bar:baz`,
        ];

        for (const sample of nonBoundaryCases) {
          expect(replaceEmojiShortcodesInText(sample, { catalog }), sample).toBe(sample);
        }
      }),
    );
  });

  it("refuses triggers and auto-expansion inside unclosed inline code spans and fenced code blocks", () => {
    fc.assert(
      fc.property(
        knownArbitrary,
        fc.constantFrom("`", "``", "```", "~~~"),
        (known, delimiter) => {
          if (delimiter.length < 3) {
            const unclosedInline = `${delimiter}:${known.code}`;
            expect(isInsideUnclosedCodeContext(unclosedInline, unclosedInline.length)).toBe(true);
            expect(findEmojiShortcodeTrigger(unclosedInline, unclosedInline.length)).toBeUndefined();
            expect(
              findExactEmojiShortcodeBeforeColon(unclosedInline, "", { catalog }),
            ).toBeUndefined();

            const afterClosedInline = `${delimiter}code${delimiter} :${known.code}`;
            expect(isInsideUnclosedCodeContext(afterClosedInline, afterClosedInline.length)).toBe(false);
            expect(findEmojiShortcodeTrigger(afterClosedInline, afterClosedInline.length)?.query).toBe(
              known.code,
            );
          } else {
            const insideFence = `${delimiter}ts\n:${known.code}`;
            expect(isInsideUnclosedCodeContext(insideFence, insideFence.length)).toBe(true);
            expect(findEmojiShortcodeTrigger(insideFence, insideFence.length)).toBeUndefined();
            expect(
              findExactEmojiShortcodeBeforeColon(insideFence, "", { catalog }),
            ).toBeUndefined();

            const afterClosedFence = `${delimiter}ts\ncode\n${delimiter}\n:${known.code}`;
            expect(isInsideUnclosedCodeContext(afterClosedFence, afterClosedFence.length)).toBe(false);
            expect(findEmojiShortcodeTrigger(afterClosedFence, afterClosedFence.length)?.query).toBe(
              known.code,
            );
          }
        },
      ),
    );
  });

  it("only opens autocomplete triggers at start of line or after whitespace", () => {
    expect(findEmojiShortcodeTrigger(":+1", 3)).toEqual({ start: 0, end: 3, query: "+1" });
    expect(findEmojiShortcodeTrigger("hello :thumbs", 13)).toEqual({
      start: 6,
      end: 13,
      query: "thumbs",
    });
    expect(findEmojiShortcodeTrigger("line1\n:rocket", 13)).toEqual({
      start: 6,
      end: 13,
      query: "rocket",
    });

    expect(findEmojiShortcodeTrigger(":", 1)).toBeUndefined();
    expect(findEmojiShortcodeTrigger("12:30", 5)).toBeUndefined();
    expect(findEmojiShortcodeTrigger("std::vec", 8)).toBeUndefined();
    expect(findEmojiShortcodeTrigger("https://example", 15)).toBeUndefined();
    expect(findEmojiShortcodeTrigger("foo:bar", 7)).toBeUndefined();
    expect(findEmojiShortcodeTrigger(":+1", 3, { atLineStart: false })).toBeUndefined();
  });

  it("fast-paths potential shortcode detection without false negatives on formatted prose", () => {
    expect(hasPotentialEmojiShortcode("Plain text with no colons")).toBe(false);
    expect(hasPotentialEmojiShortcode("Meeting at 12:30 today")).toBe(false);
    expect(hasPotentialEmojiShortcode("std::vector<int>")).toBe(false);
    expect(hasPotentialEmojiShortcode(":+1:")).toBe(true);
    expect(hasPotentialEmojiShortcode("**:+1:**")).toBe(true);
  });
});
