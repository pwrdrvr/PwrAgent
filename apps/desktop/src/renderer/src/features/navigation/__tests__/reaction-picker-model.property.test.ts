import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { buildReactionEmojiCatalog } from "../reaction-emoji-catalog";
import {
  INITIAL_REACTION_PICKER_LEAVE_STATE,
  LABEL_LETTER_REACTIONS,
  LABEL_NUMBER_REACTIONS,
  QUICK_REACTIONS,
  REACTION_CATEGORIES,
  computeReactionPickerPosition,
  createLazyValueCache,
  isSyntheticStationaryPointerLeave,
  moveReactionGridIndex,
  normalizeEmojiKey,
  recordRecentReactionList,
  searchReactionEmojis,
  transitionReactionPickerLeaveState,
  type ReactionPickerLeaveEvent,
} from "../reaction-picker-model";
import {
  applyPendingThreadReactions,
  applyThreadReactionToggle,
} from "../../../lib/useThreadNavigation";

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

describe("2D multi-section reaction grid navigation properties", () => {
  it("moves row-by-row across sections, preserving column clamped to the target row", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 4 }),
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
        (sectionLengths, columns, rawIndex, key) => {
          const total = sectionLengths.reduce((sum, len) => sum + len, 0);
          const currentIndex = rawIndex % total;
          const next = moveReactionGridIndex(
            currentIndex,
            key,
            sectionLengths,
            columns,
          );
          const firstRowLength = Math.min(columns, sectionLengths[0]!);
          if (key === "ArrowUp" && currentIndex < firstRowLength) {
            expect(next).toBeUndefined();
          } else {
            expect(next).toBeTypeOf("number");
            expect(next).toBeGreaterThanOrEqual(0);
            expect(next).toBeLessThan(total);
          }
        },
      ),
    );
  });

  it("navigates across uneven section boundaries without skipping sections or shifting columns", () => {
    // 1 recent item above 16 quick items (8 columns):
    // Row 0: [0], Row 1: [1..8], Row 2: [9..16]
    expect(moveReactionGridIndex(0, "ArrowDown", [1, 16], 8)).toBe(1);
    expect(moveReactionGridIndex(3, "ArrowUp", [1, 16], 8)).toBe(0);
    expect(moveReactionGridIndex(0, "ArrowUp", [1, 16], 8)).toBeUndefined();

    // Numbers & Letters: 11 numbers (0..10) above 26 letters (11..36)
    // Row 0: [0..7], Row 1: [8..10], Row 2: [11..18]
    expect(moveReactionGridIndex(8, "ArrowDown", [11, 26], 8)).toBe(11);
    expect(moveReactionGridIndex(11, "ArrowUp", [11, 26], 8)).toBe(8);
    expect(moveReactionGridIndex(15, "ArrowUp", [11, 26], 8)).toBe(10);
  });
});

describe("lazy value cache lifecycle", () => {
  it("clears a rejected load promise so the next open retries and caches on success", async () => {
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValueOnce("catalog-ok");

    const cache = createLazyValueCache(loader);
    await expect(cache.load()).rejects.toThrow("chunk failed");
    expect(cache.getCached()).toBeUndefined();

    await expect(cache.load()).resolves.toBe("catalog-ok");
    expect(cache.getCached()).toBe("catalog-ok");
    await expect(cache.load()).resolves.toBe("catalog-ok");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("reaction picker post-pick leave-dismiss state machine", () => {
  it("matches an independent oracle for hasPicked preservation, timer arming, and cancellation across all event sequences", () => {
    const events = fc.constantFrom<ReactionPickerLeaveEvent>(
      "pick",
      "pointer_enter",
      "pointer_leave",
      "interact_inside",
      "dismiss_immediate",
    );

    fc.assert(
      fc.property(fc.array(events, { minLength: 1, maxLength: 40 }), (sequence) => {
        let state = INITIAL_REACTION_PICKER_LEAVE_STATE;
        let expectedHasPicked = false;
        let expectedTimerArmed = false;

        for (const event of sequence) {
          const next = transitionReactionPickerLeaveState(state, event);
          state = next.state;

          if (event === "dismiss_immediate") {
            expectedHasPicked = false;
            expectedTimerArmed = false;
            expect(next.effect).toBe("dismiss_now");
            expect(state).toEqual({
              hasPicked: expectedHasPicked,
              leaveTimerArmed: expectedTimerArmed,
            });
            continue;
          }

          if (event === "pointer_leave") {
            if (!expectedHasPicked) {
              expect(next.effect).toBe("none");
              expect(state).toEqual({
                hasPicked: false,
                leaveTimerArmed: false,
              });
            } else {
              expectedTimerArmed = true;
              expect(next.effect).toBe("arm_timer");
              expect(state).toEqual({
                hasPicked: true,
                leaveTimerArmed: true,
              });
            }
            continue;
          }

          const expectedEffect = expectedTimerArmed ? "cancel_timer" : "none";
          expectedTimerArmed = false;
          if (event === "pick") {
            expectedHasPicked = true;
          }
          expect(next.effect).toBe(expectedEffect);
          expect(state).toEqual({
            hasPicked: expectedHasPicked,
            leaveTimerArmed: expectedTimerArmed,
          });
        }
      }),
    );
  });

  it("identifies synthetic stationary mouseleave only when coordinates match the last recorded inside pointer", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 2000 }),
        fc.integer({ min: 8, max: 1400 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 1400 }),
        (insideX, insideY, leaveX, leaveY) => {
          expect(
            isSyntheticStationaryPointerLeave(undefined, { x: leaveX, y: leaveY }),
          ).toBe(false);
          expect(
            isSyntheticStationaryPointerLeave(
              { x: insideX, y: insideY },
              { x: insideX, y: insideY },
            ),
          ).toBe(true);
          expect(
            isSyntheticStationaryPointerLeave(
              { x: insideX, y: insideY },
              { x: leaveX, y: leaveY },
            ),
          ).toBe(insideX === leaveX && insideY === leaveY);
        },
      ),
    );
  });
});

describe("pending thread reaction reconciliation properties", () => {
  it("preserves every queued toggle in click order on top of stale or concurrent server snapshots", () => {
    const emojiPool = fc.constantFrom("👍", "👎", "🚀", "🔥", "🎉", "👀", "✅");
    const mutationArb = fc.record({
      emoji: emojiPool,
      present: fc.boolean(),
    });

    fc.assert(
      fc.property(
        fc.uniqueArray(emojiPool, { maxLength: 5 }),
        fc.array(mutationArb, { minLength: 1, maxLength: 15 }),
        (initialServer, mutations) => {
          // Simulate applying prefix `k` on the server while suffix `k..n`
          // remains pending on the client: every intermediate server snapshot
          // overlaid with remaining pending mutations must match applying all
          // mutations to the initial server state.
          let fullExpected: string[] = [...initialServer];
          for (const m of mutations) {
            fullExpected = applyThreadReactionToggle(
              fullExpected,
              m.emoji,
              m.present,
            );
          }

          let serverState: string[] = [...initialServer];
          for (let completed = 0; completed <= mutations.length; completed++) {
            const pending = mutations.slice(completed);
            const visible = applyPendingThreadReactions(serverState, pending);
            expect(visible).toEqual(fullExpected);
            if (completed < mutations.length) {
              const nextMutation = mutations[completed]!;
              serverState = applyThreadReactionToggle(
                serverState,
                nextMutation.emoji,
                nextMutation.present,
              );
            }
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

  it("does not match the full catalog on hyphen or underscore punctuation queries", () => {
    const dashMatches = searchReactionEmojis(catalog.all, "-");
    expect(dashMatches[0]?.emoji).toBe("👎");
    expect(dashMatches.some((entry) => entry.emoji === "👍")).toBe(false);

    for (const query of ["_", "--", ":_:", "___"]) {
      expect(searchReactionEmojis(catalog.all, query), `query=${query}`).toEqual(
        [],
      );
    }

    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("-", "_", ":"), { minLength: 1, maxLength: 5 }),
        (chars) => {
          const query = chars.join("");
          const matches = searchReactionEmojis(catalog.all, query);
          expect(matches.some((entry) => entry.emoji === "👍")).toBe(false);
        },
      ),
    );
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
