export type ReactionCategoryId =
  | "quick"
  | "smileys_emotion"
  | "people_body"
  | "animals_nature"
  | "food_drink"
  | "travel_activities"
  | "objects"
  | "symbols"
  | "labels"
  | "flags";

export type ReactionCategoryMeta = {
  id: ReactionCategoryId;
  label: string;
};

export type ReactionEmojiEntry = {
  emoji: string;
  name: string;
  shortcode: string;
  category: ReactionCategoryId;
  keywords: readonly string[];
  isQuick?: boolean;
};

export type ReactionPickerAnchorRect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type ReactionPickerSize = {
  width: number;
  height: number;
};

export type ReactionPickerViewport = {
  width: number;
  height: number;
};

export type ReactionPickerPlacement = {
  top: number;
  left: number;
  side: "below" | "above";
};

export const REACTION_PICKER_COLUMNS = 8;
export const REACTION_RECENTS_STORAGE_KEY = "pwragent.reaction-picker.recents";
export const REACTION_RECENTS_LIMIT = 8;
export const REACTION_SEARCH_RESULT_LIMIT = 80;

const PICKER_GAP_PX = 6;
const PICKER_VIEWPORT_MARGIN_PX = 8;

export const REACTION_CATEGORIES: readonly ReactionCategoryMeta[] = [
  { id: "quick", label: "Quick" },
  { id: "smileys_emotion", label: "Smileys & Emotion" },
  { id: "people_body", label: "People & Gestures" },
  { id: "animals_nature", label: "Animals & Nature" },
  { id: "food_drink", label: "Food & Drink" },
  { id: "travel_activities", label: "Travel & Activities" },
  { id: "objects", label: "Objects" },
  { id: "symbols", label: "Symbols" },
  { id: "labels", label: "Numbers & Letters" },
  { id: "flags", label: "Flags" },
];

export const QUICK_REACTIONS: readonly ReactionEmojiEntry[] = [
  {
    emoji: "👍",
    name: "Thumbs up",
    shortcode: "+1",
    category: "people_body",
    keywords: ["+1", "thumbsup", "thumbs_up", "approve", "lgtm", "yes", "good", "ok", "like"],
    isQuick: true,
  },
  {
    emoji: "👎",
    name: "Thumbs down",
    shortcode: "-1",
    category: "people_body",
    keywords: ["-1", "thumbsdown", "thumbs_down", "reject", "no", "bad", "dislike"],
    isQuick: true,
  },
  {
    emoji: "👀",
    name: "Eyes",
    shortcode: "eyes",
    category: "people_body",
    keywords: ["eyes", "looking", "review", "watching", "peek", "see"],
    isQuick: true,
  },
  {
    emoji: "✅",
    name: "Check mark button",
    shortcode: "white_check_mark",
    category: "symbols",
    keywords: ["check", "done", "pass", "ok", "yes", "approved", "lgtm", "green_check"],
    isQuick: true,
  },
  {
    emoji: "❌",
    name: "Cross mark",
    shortcode: "x",
    category: "symbols",
    keywords: ["x", "cross", "no", "fail", "blocked", "reject", "stop", "cancel"],
    isQuick: true,
  },
  {
    emoji: "🚀",
    name: "Rocket",
    shortcode: "rocket",
    category: "travel_activities",
    keywords: ["rocket", "ship", "shipit", "launch", "deploy", "fast"],
    isQuick: true,
  },
  {
    emoji: "🎉",
    name: "Party popper",
    shortcode: "tada",
    category: "travel_activities",
    keywords: ["tada", "party", "celebrate", "congrats", "hooray", "yay"],
    isQuick: true,
  },
  {
    emoji: "🔥",
    name: "Fire",
    shortcode: "fire",
    category: "travel_activities",
    keywords: ["fire", "hot", "lit", "flame", "urgent", "burn"],
    isQuick: true,
  },
  {
    emoji: "❤️",
    name: "Red heart",
    shortcode: "heart",
    category: "smileys_emotion",
    keywords: ["heart", "love", "like", "favorite", "red_heart"],
    isQuick: true,
  },
  {
    emoji: "🤔",
    name: "Thinking face",
    shortcode: "thinking",
    category: "smileys_emotion",
    keywords: ["thinking", "hmm", "question", "wonder", "consider", "curious"],
    isQuick: true,
  },
  {
    emoji: "⚠️",
    name: "Warning",
    shortcode: "warning",
    category: "symbols",
    keywords: ["warning", "warn", "caution", "alert", "careful", "wip"],
    isQuick: true,
  },
  {
    emoji: "🐛",
    name: "Bug",
    shortcode: "bug",
    category: "animals_nature",
    keywords: ["bug", "issue", "defect", "insect", "broken"],
    isQuick: true,
  },
  {
    emoji: "💡",
    name: "Light bulb",
    shortcode: "bulb",
    category: "objects",
    keywords: ["bulb", "idea", "tip", "insight", "hint", "light"],
    isQuick: true,
  },
  {
    emoji: "🙏",
    name: "Folded hands",
    shortcode: "pray",
    category: "people_body",
    keywords: ["pray", "thanks", "please", "thank_you", "grateful", "appreciate"],
    isQuick: true,
  },
  {
    emoji: "😱",
    name: "Face screaming in fear",
    shortcode: "scream",
    category: "smileys_emotion",
    keywords: ["scream", "omg", "panic", "shock", "whoa", "yikes"],
    isQuick: true,
  },
  {
    emoji: "💩",
    name: "Pile of poo",
    shortcode: "poop",
    category: "smileys_emotion",
    keywords: ["poop", "poo", "hankey", "shit", "crap", "bad"],
    isQuick: true,
  },
];

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

const KEYCAP_NUMBERS = [
  "0️⃣",
  "1️⃣",
  "2️⃣",
  "3️⃣",
  "4️⃣",
  "5️⃣",
  "6️⃣",
  "7️⃣",
  "8️⃣",
  "9️⃣",
  "🔟",
] as const;

export const LABEL_NUMBER_REACTIONS: readonly ReactionEmojiEntry[] = KEYCAP_NUMBERS.map(
  (emoji, index) => ({
    emoji,
    name: `Number ${index}`,
    shortcode: String(index),
    category: "labels",
    keywords: [
      String(index),
      NUMBER_WORDS[index]!,
      `keycap_${index}`,
      `p${index}`,
      "number",
      "numbers",
      "digit",
      "label",
      "priority",
    ],
  }),
);

// Negative-circled Latin capitals (U+1F150..U+1F169). They render as solid
// badges with white letters, matching the visual weight of keycap numbers.
export const LABEL_LETTER_REACTIONS: readonly ReactionEmojiEntry[] = Array.from(
  { length: 26 },
  (_, index) => {
    const upper = String.fromCharCode(65 + index);
    const lower = upper.toLowerCase();
    return {
      emoji: String.fromCodePoint(0x1f150 + index),
      name: `Letter ${upper}`,
      shortcode: `letter_${lower}`,
      category: "labels",
      keywords: [lower, `letter ${lower}`, `letter_${lower}`, "letter", "alpha", "alphabet", "label", "badge"],
    };
  },
);

export const BASE_REACTION_ENTRIES: readonly ReactionEmojiEntry[] = [
  ...QUICK_REACTIONS,
  ...LABEL_NUMBER_REACTIONS,
  ...LABEL_LETTER_REACTIONS,
];

export const EXTRA_DEVELOPER_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "👍": ["+1", "thumbsup", "lgtm", "approve", "yes"],
  "👎": ["-1", "thumbsdown", "reject", "no"],
  "✅": ["lgtm", "done", "pass", "check", "approved"],
  "❌": ["fail", "blocked", "reject", "no", "x"],
  "🚀": ["ship", "shipit", "deploy", "launch"],
  "🚧": ["wip", "construction", "progress", "draft"],
  "📌": ["pin", "pinned", "important", "bookmark"],
  "🔒": ["lock", "locked", "private", "security"],
  "🔓": ["unlock", "unlocked", "open"],
  "💯": ["100", "perfect", "score", "agree"],
  "⚡": ["zap", "fast", "perf", "performance", "quick"],
  "✨": ["sparkles", "new", "feature", "clean", "polish"],
  "🔧": ["wrench", "fix", "config", "tool"],
  "🧪": ["test", "testing", "experiment", "lab"],
  "📝": ["memo", "note", "docs", "draft"],
  "🎯": ["target", "bullseye", "goal", "focus", "hit"],
  "🏁": ["finish", "done", "flag", "complete"],
  "⏳": ["wait", "waiting", "pending", "loading", "slow"],
  "🛑": ["stop", "halt", "blocker", "blocked"],
  "✋": ["hand", "stop", "hold", "wait", "pause"],
};

export function normalizeEmojiKey(emoji: string): string {
  return emoji.replace(/\uFE0F/g, "");
}

export function formatEmojiDisplayName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return "Emoji";
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

const LITERAL_EMOJI_PATTERN =
  /[\p{Extended_Pictographic}\u{1F150}-\u{1F169}\u{1F1E6}-\u{1F1FF}]|[0-9#*]\uFE0F?\u20E3/u;

function extractFirstEmojiGrapheme(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || !LITERAL_EMOJI_PATTERN.test(trimmed)) {
    return undefined;
  }
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    for (const { segment } of segmenter.segment(trimmed)) {
      if (LITERAL_EMOJI_PATTERN.test(segment)) {
        return segment;
      }
    }
  }
  return trimmed;
}

function normalizeSearchToken(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").trim();
}

type PrecomputedSearchEntry = {
  normalizedEmoji: string;
  lowerName: string;
  nameWords: readonly string[];
  lowerShortcode: string;
  normalizedShortcode: string;
  lowerKeywords: readonly string[];
  normalizedKeywords: readonly string[];
  searchable: string;
};

const searchEntryCache = new WeakMap<ReactionEmojiEntry, PrecomputedSearchEntry>();

function getPrecomputedSearchEntry(entry: ReactionEmojiEntry): PrecomputedSearchEntry {
  const cached = searchEntryCache.get(entry);
  if (cached) {
    return cached;
  }
  const lowerName = entry.name.toLowerCase();
  const lowerShortcode = entry.shortcode.toLowerCase();
  const normalizedShortcode = normalizeSearchToken(entry.shortcode);
  const lowerKeywords = entry.keywords.map((keyword) => keyword.toLowerCase());
  const normalizedKeywords = entry.keywords.map((keyword) => normalizeSearchToken(keyword));
  const precomputed: PrecomputedSearchEntry = {
    normalizedEmoji: normalizeEmojiKey(entry.emoji),
    lowerName,
    nameWords: lowerName.split(/\s+/),
    lowerShortcode,
    normalizedShortcode,
    lowerKeywords,
    normalizedKeywords,
    searchable: `${lowerName} ${lowerShortcode} ${normalizedShortcode} ${lowerKeywords.join(" ")}`,
  };
  searchEntryCache.set(entry, precomputed);
  return precomputed;
}

function scoreEntry(
  entry: ReactionEmojiEntry,
  rawLower: string,
  normalizedRawEmoji: string,
  normalizedQuery: string,
  queryTokens: readonly string[],
): number | undefined {
  const indexed = getPrecomputedSearchEntry(entry);
  if (
    entry.emoji === rawLower
    || indexed.normalizedEmoji === normalizedRawEmoji
  ) {
    return 0;
  }

  const hasNormalizedQuery = normalizedQuery.length > 0;

  if (
    indexed.lowerShortcode === rawLower
    || (hasNormalizedQuery
      && (indexed.lowerName === normalizedQuery || indexed.normalizedShortcode === normalizedQuery))
  ) {
    return 1;
  }

  if (
    indexed.lowerShortcode.startsWith(rawLower)
    || (hasNormalizedQuery
      && (indexed.lowerName.startsWith(normalizedQuery)
        || indexed.normalizedShortcode.startsWith(normalizedQuery)))
    || (entry.isQuick === true
      && hasExactKeywordMatch(indexed, rawLower, normalizedQuery, hasNormalizedQuery))
  ) {
    return 2;
  }

  if (hasExactKeywordMatch(indexed, rawLower, normalizedQuery, hasNormalizedQuery)) {
    return 3;
  }

  if (
    (hasNormalizedQuery && indexed.nameWords.some((word) => word.startsWith(normalizedQuery)))
    || hasPrefixKeywordMatch(indexed, rawLower, normalizedQuery, hasNormalizedQuery)
  ) {
    return 4;
  }

  if (queryTokens.length > 0) {
    if (queryTokens.every((token) => indexed.searchable.includes(token))) {
      return 5;
    }
  }

  return undefined;
}

function hasExactKeywordMatch(
  indexed: PrecomputedSearchEntry,
  rawLower: string,
  normalizedQuery: string,
  hasNormalizedQuery: boolean,
): boolean {
  for (let i = 0; i < indexed.lowerKeywords.length; i += 1) {
    if (
      indexed.lowerKeywords[i] === rawLower
      || (hasNormalizedQuery && indexed.normalizedKeywords[i] === normalizedQuery)
    ) {
      return true;
    }
  }
  return false;
}

function hasPrefixKeywordMatch(
  indexed: PrecomputedSearchEntry,
  rawLower: string,
  normalizedQuery: string,
  hasNormalizedQuery: boolean,
): boolean {
  for (let i = 0; i < indexed.lowerKeywords.length; i += 1) {
    if (
      indexed.lowerKeywords[i]!.startsWith(rawLower)
      || (hasNormalizedQuery && indexed.normalizedKeywords[i]!.startsWith(normalizedQuery))
    ) {
      return true;
    }
  }
  return false;
}

export function searchReactionEmojis(
  entries: readonly ReactionEmojiEntry[],
  rawQuery: string,
  limit = REACTION_SEARCH_RESULT_LIMIT,
): ReactionEmojiEntry[] {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return [];
  }

  const strippedColons = trimmed.replace(/^:+|:+$/g, "").trim();
  const rawLower = (strippedColons || trimmed).toLowerCase();
  const normalizedRawEmoji = normalizeEmojiKey(rawLower);
  const normalizedQuery = normalizeSearchToken(rawLower);
  const queryTokens = normalizedQuery
    .split(/\s+/)
    .filter((token) => token.length > 0);

  const scored: { entry: ReactionEmojiEntry; tier: number; order: number }[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const tier = scoreEntry(entry, rawLower, normalizedRawEmoji, normalizedQuery, queryTokens);
    if (tier !== undefined) {
      scored.push({ entry, tier, order: index });
    }
  }

  scored.sort((left, right) => {
    if (left.tier !== right.tier) {
      return left.tier - right.tier;
    }
    const leftQuick = left.entry.isQuick === true ? 0 : 1;
    const rightQuick = right.entry.isQuick === true ? 0 : 1;
    if (leftQuick !== rightQuick) {
      return leftQuick - rightQuick;
    }
    return left.order - right.order;
  });

  const results = scored.slice(0, limit).map((item) => item.entry);

  // If the user pasted or typed a literal emoji (such as a skin-tone variant or
  // ZWJ sequence) that is not already an exact match in the catalog, offer it
  // first so any Unicode emoji works directly without a separate custom input.
  const literalEmoji = extractFirstEmojiGrapheme(trimmed);
  if (
    literalEmoji
    && !results.some(
      (entry) =>
        entry.emoji === literalEmoji
        || normalizeEmojiKey(entry.emoji) === normalizeEmojiKey(literalEmoji),
    )
  ) {
    const customEntry: ReactionEmojiEntry = {
      emoji: literalEmoji,
      name: `Use ${literalEmoji}`,
      shortcode: "custom",
      category: "quick",
      keywords: [literalEmoji],
    };
    return [customEntry, ...results.slice(0, Math.max(0, limit - 1))];
  }

  return results;
}

export function computeReactionPickerPosition(
  anchor: ReactionPickerAnchorRect,
  picker: ReactionPickerSize,
  viewport: ReactionPickerViewport,
): ReactionPickerPlacement {
  const maxLeft = Math.max(
    PICKER_VIEWPORT_MARGIN_PX,
    viewport.width - PICKER_VIEWPORT_MARGIN_PX - picker.width,
  );
  const left = Math.max(
    PICKER_VIEWPORT_MARGIN_PX,
    Math.min(anchor.left, maxLeft),
  );

  const belowTop = anchor.bottom + PICKER_GAP_PX;
  const aboveTop = anchor.top - PICKER_GAP_PX - picker.height;
  const spaceBelow = viewport.height - PICKER_VIEWPORT_MARGIN_PX - belowTop;
  const spaceAbove = anchor.top - PICKER_GAP_PX - PICKER_VIEWPORT_MARGIN_PX;

  const fitsBelow = spaceBelow >= picker.height;
  const fitsAbove = spaceAbove >= picker.height;

  let side: "below" | "above";
  let rawTop: number;
  if (fitsBelow) {
    side = "below";
    rawTop = belowTop;
  } else if (fitsAbove || spaceAbove > spaceBelow) {
    side = "above";
    rawTop = aboveTop;
  } else {
    side = "below";
    rawTop = belowTop;
  }

  const maxTop = Math.max(
    PICKER_VIEWPORT_MARGIN_PX,
    viewport.height - PICKER_VIEWPORT_MARGIN_PX - picker.height,
  );
  const top = Math.max(PICKER_VIEWPORT_MARGIN_PX, Math.min(rawTop, maxTop));

  return { top, left, side };
}

export function moveReactionGridIndex(
  currentIndex: number,
  key: string,
  sectionLengths: readonly number[],
  columns = REACTION_PICKER_COLUMNS,
): number | undefined {
  if (columns <= 0) {
    return undefined;
  }

  const rows: { start: number; length: number }[] = [];
  let totalItems = 0;
  for (const sectionLength of sectionLengths) {
    if (sectionLength <= 0) {
      continue;
    }
    for (let offset = 0; offset < sectionLength; offset += columns) {
      rows.push({
        start: totalItems + offset,
        length: Math.min(columns, sectionLength - offset),
      });
    }
    totalItems += sectionLength;
  }

  if (totalItems <= 0 || rows.length === 0) {
    return undefined;
  }

  const safeIndex = Math.max(0, Math.min(currentIndex, totalItems - 1));
  switch (key) {
    case "ArrowRight":
      return (safeIndex + 1) % totalItems;
    case "ArrowLeft":
      return (safeIndex - 1 + totalItems) % totalItems;
    case "Home":
      return 0;
    case "End":
      return totalItems - 1;
    case "ArrowDown":
    case "ArrowUp": {
      const rowIdx = rows.findIndex(
        (row) => safeIndex >= row.start && safeIndex < row.start + row.length,
      );
      if (rowIdx < 0) {
        return undefined;
      }
      const colIdx = safeIndex - rows[rowIdx]!.start;
      if (key === "ArrowDown") {
        if (rowIdx + 1 >= rows.length) {
          return totalItems - 1;
        }
        const nextRow = rows[rowIdx + 1]!;
        return nextRow.start + Math.min(colIdx, nextRow.length - 1);
      }
      if (rowIdx === 0) {
        return undefined;
      }
      const prevRow = rows[rowIdx - 1]!;
      return prevRow.start + Math.min(colIdx, prevRow.length - 1);
    }
    default:
      return undefined;
  }
}

export type LazyValueCache<T> = {
  getCached: () => T | undefined;
  load: () => Promise<T>;
};

export type ReactionPickerLeaveState = {
  hasPicked: boolean;
  leaveTimerArmed: boolean;
};

export type ReactionPickerLeaveEvent =
  | "pick"
  | "pointer_enter"
  | "pointer_leave"
  | "interact_inside"
  | "dismiss_immediate";

export type ReactionPickerLeaveTransition = {
  state: ReactionPickerLeaveState;
  effect: "none" | "arm_timer" | "cancel_timer" | "dismiss_now";
};

export type ReactionPickerPointerPoint = {
  x: number;
  y: number;
};

/**
 * Returns true when a `mouseleave` event fires at the exact same viewport
 * coordinates as the last pointer position observed inside the picker.
 *
 * That happens when layout shrinks or shifts out from under a stationary
 * cursor (for example, hiding category tabs or narrowing search results, or
 * repositioning an above-anchored picker), rather than when the user actually
 * moved the pointer away.
 */
export function isSyntheticStationaryPointerLeave(
  lastInsidePointer: ReactionPickerPointerPoint | undefined,
  leavePointer: ReactionPickerPointerPoint,
): boolean {
  if (!lastInsidePointer) {
    return false;
  }
  return (
    lastInsidePointer.x === leavePointer.x
    && lastInsidePointer.y === leavePointer.y
  );
}

export const INITIAL_REACTION_PICKER_LEAVE_STATE: ReactionPickerLeaveState = {
  hasPicked: false,
  leaveTimerArmed: false,
};

/**
 * Coordinates multi-select stay-open and pointer-leave auto-close behavior:
 *
 * - Before any reaction is picked, leaving the popover does nothing so the
 *   user can cross from the trigger or read the sidebar without losing it.
 * - Picking a reaction keeps the popover open and arms pointer-leave close.
 * - Leaving after a pick schedules a short grace timer; re-entering, typing,
 *   or picking again cancels the timer.
 * - Explicit dismissal (outside click or Escape) always cancels and closes
 *   immediately.
 */
export function transitionReactionPickerLeaveState(
  state: ReactionPickerLeaveState,
  event: ReactionPickerLeaveEvent,
): ReactionPickerLeaveTransition {
  switch (event) {
    case "pick":
      return {
        state: { hasPicked: true, leaveTimerArmed: false },
        effect: state.leaveTimerArmed ? "cancel_timer" : "none",
      };
    case "pointer_leave":
      if (!state.hasPicked) {
        return { state, effect: "none" };
      }
      return {
        state: { hasPicked: true, leaveTimerArmed: true },
        effect: "arm_timer",
      };
    case "pointer_enter":
    case "interact_inside":
      return {
        state: { ...state, leaveTimerArmed: false },
        effect: state.leaveTimerArmed ? "cancel_timer" : "none",
      };
    case "dismiss_immediate":
      return {
        state: { hasPicked: false, leaveTimerArmed: false },
        effect: "dismiss_now",
      };
  }
}

export function createLazyValueCache<T>(
  loader: () => Promise<T>,
): LazyValueCache<T> {
  let cached: T | undefined;
  let pending: Promise<T> | undefined;

  return {
    getCached: () => cached,
    load: () => {
      if (cached !== undefined) {
        return Promise.resolve(cached);
      }
      if (!pending) {
        pending = loader()
          .then((value) => {
            cached = value;
            return value;
          })
          .catch((error: unknown) => {
            pending = undefined;
            throw error;
          });
      }
      return pending;
    },
  };
}

export function normalizeRecentReactions(
  raw: unknown,
  limit = REACTION_RECENTS_LIMIT,
): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizeEmojiKey(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

export function recordRecentReactionList(
  current: readonly string[],
  emoji: string,
  limit = REACTION_RECENTS_LIMIT,
): string[] {
  const trimmed = emoji.trim();
  if (!trimmed) {
    return [...current].slice(0, limit);
  }
  const key = normalizeEmojiKey(trimmed);
  return [
    trimmed,
    ...current.filter((existing) => normalizeEmojiKey(existing) !== key),
  ].slice(0, limit);
}

export function readRecentReactions(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(REACTION_RECENTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    return normalizeRecentReactions(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeRecentReactions(recents: readonly string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      REACTION_RECENTS_STORAGE_KEY,
      JSON.stringify(recents.slice(0, REACTION_RECENTS_LIMIT)),
    );
  } catch {
    // Ignore storage errors (private mode / blocked quota).
  }
}
