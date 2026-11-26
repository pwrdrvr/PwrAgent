import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildReactionEmojiCatalog } from "../reaction-emoji-catalog";
import {
  LABEL_LETTER_REACTIONS,
  LABEL_NUMBER_REACTIONS,
  QUICK_REACTIONS,
  REACTION_CATEGORIES,
  computeReactionPickerPosition,
  moveReactionGridIndex,
  normalizeEmojiKey,
  recordRecentReactionList,
  searchReactionEmojis,
} from "../reaction-picker-model";

describe("reaction picker positioning properties", () => {
  it("keeps the picker within viewport margins whenever it fits", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 400, max: 2000 }),
        fc.integer({ min: 420, max: 1400 }),
        fc.integer({ min: 200, max: 360 }),
        fc.integer({ min: 200, max: 380 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 1400 }),
        (vpWidth, vpHeight, pickerWidth, pickerHeight, rawLeft, rawTop) => {
          const anchorLeft = Math.min(rawLeft, vpWidth - 20);
          const anchorTop = Math.min(rawTop, vpHeight - 20);
          const placement = computeReactionPickerPosition(
            {
              top: anchorTop,
              bottom: anchorTop + 20,
              left: anchorLeft,
              right: anchorLeft + 24,
            },
            { width: pickerWidth, height: pickerHeight },
            { width: vpWidth, height: vpHeight },
          );

          expect(placement.left).toBeGreaterThanOrEqual(8);
          expect(placement.left + pickerWidth).toBeLessThanOrEqual(vpWidth - 8);
          expect(placement.top).toBeGreaterThanOrEqual(8);
          expect(placement.top + pickerHeight).toBeLessThanOrEqual(vpHeight - 8);
        },
      ),
    );
  });

  it("flips above the anchor when opening below would clip the bottom edge", () => {
    const placement = computeReactionPickerPosition(
      { top: 740, bottom: 760, left: 200, right: 224 },
      { width: 316, height: 356 },
      { width: 1280, height: 800 },
    );

    expect(placement.side).toBe("above");
    expect(placement.top + 356).toBeLessThanOrEqual(740 - 6);
  });
});

describe("recent reaction list properties", () => {
  it("places the latest emoji first without variation-selector duplicates and obeys the limit", () => {
    const emojiPool = fc.constantFrom(
      "👍",
      "👎",
      "🚀",
      "❤️",
      "❤",
      "⚠️",
      "⚠",
      "💩",
      "🔥",
      "🎉",
      "👀",
      "✅",
    );

    fc.assert(
      fc.property(
        fc.array(emojiPool, { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 10 }),
        (picks, limit) => {
          let list: string[] = [];
          for (const emoji of picks) {
            list = recordRecentReactionList(list, emoji, limit);
            expect(list.length).toBeLessThanOrEqual(limit);
            expect(list[0]).toBe(emoji);
            const normalized = list.map((item) => normalizeEmojiKey(item));
            expect(new Set(normalized).size).toBe(normalized.length);
          }
        },
      ),
    );
  });
});

describe("2D reaction grid navigation properties", () => {
  it("always returns undefined (escape to search) or an in-bounds index", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 120 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 150 }),
        fc.constantFrom(
          "ArrowRight",
          "ArrowLeft",
          "ArrowDown",
          "ArrowUp",
          "Home",
          "End",
        ),
        (itemCount, columns, rawIndex, key) => {
          const currentIndex = rawIndex % itemCount;
          const next = moveReactionGridIndex(currentIndex, key, itemCount, columns);
          if (key === "ArrowUp" && currentIndex < columns) {
            expect(next).toBeUndefined();
          } else {
            expect(next).toBeTypeOf("number");
            expect(next).toBeGreaterThanOrEqual(0);
            expect(next).toBeLessThan(itemCount);
          }
        },
      ),
    );
  });
});

describe("reaction emoji catalog and search", () => {
  const catalog = buildReactionEmojiCatalog();

  it("populates every category with deduplicated Unicode emojis plus full 0-10 and A-Z labels", () => {
    expect(catalog.all.length).toBeGreaterThan(1800);
    const keys = catalog.all.map((entry) => normalizeEmojiKey(entry.emoji));
    expect(new Set(keys).size).toBe(keys.length);

    for (const category of REACTION_CATEGORIES) {
      expect(catalog.byCategory[category.id].length).toBeGreaterThan(0);
    }

    expect(QUICK_REACTIONS[0]?.emoji).toBe("👍");
    expect(LABEL_NUMBER_REACTIONS).toHaveLength(11);
    expect(LABEL_LETTER_REACTIONS).toHaveLength(26);
    expect(LABEL_LETTER_REACTIONS[0]?.emoji).toBe("🅐");
    expect(LABEL_LETTER_REACTIONS[25]?.emoji).toBe("🅩");
  });

  it("ranks thumbs up first for thumbs, +1, :+1:, and lgtm queries", () => {
    for (const query of ["thumbs", "+1", ":+1:", "thumbsup", "lgtm"]) {
      const matches = searchReactionEmojis(catalog.all, query);
      expect(matches[0]?.emoji, `query=${query}`).toBe("👍");
    }
  });

  it("finds full-catalog emojis, numbers, and letters by name and shortcode", () => {
    expect(searchReactionEmojis(catalog.all, "fire")[0]?.emoji).toBe("🔥");
    expect(searchReactionEmojis(catalog.all, "bug")[0]?.emoji).toBe("🐛");
    expect(searchReactionEmojis(catalog.all, "poop")[0]?.emoji).toBe("💩");
    expect(searchReactionEmojis(catalog.all, "avocado")[0]?.emoji).toBe("🥑");
    expect(searchReactionEmojis(catalog.all, "unicorn")[0]?.emoji).toBe("🦄");
    expect(
      searchReactionEmojis(catalog.all, "3").some((entry) => entry.emoji === "3️⃣"),
    ).toBe(true);
    expect(
      searchReactionEmojis(catalog.all, "letter z")[0]?.emoji,
    ).toBe("🅩");
  });

  it("accepts pasted skin-tone and ZWJ emojis directly without a custom text box", () => {
    const skinTone = searchReactionEmojis(catalog.all, "👍🏽");
    expect(skinTone[0]?.emoji).toBe("👍🏽");

    const zwj = searchReactionEmojis(catalog.all, "👨‍💻");
    expect(zwj[0]?.emoji).toBe("👨‍💻");
  });
});
