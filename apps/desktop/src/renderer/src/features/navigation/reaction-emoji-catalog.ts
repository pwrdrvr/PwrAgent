import emojiKeywords from "emojilib";
import emojiGroups from "unicode-emoji-json/data-by-group.json";
import {
  EXTRA_DEVELOPER_KEYWORDS,
  LABEL_LETTER_REACTIONS,
  LABEL_NUMBER_REACTIONS,
  QUICK_REACTIONS,
  formatEmojiDisplayName,
  normalizeEmojiKey,
  type ReactionCategoryId,
  type ReactionEmojiEntry,
} from "./reaction-picker-model";

type UnicodeEmojiItem = {
  emoji: string;
  name: string;
  slug: string;
};

type UnicodeEmojiGroup = {
  name: string;
  slug: string;
  emojis: UnicodeEmojiItem[];
};

export type ReactionEmojiCatalog = {
  all: readonly ReactionEmojiEntry[];
  byCategory: Readonly<Record<ReactionCategoryId, readonly ReactionEmojiEntry[]>>;
  byKey: ReadonlyMap<string, ReactionEmojiEntry>;
  byShortcode: ReadonlyMap<string, ReactionEmojiEntry>;
};

const EXTRA_SHORTCODE_ALIASES: Readonly<Record<string, string>> = {
  thumbsup: "👍",
  thumbsdown: "👎",
  "100": "💯",
  smile: "😄",
  smiley: "😃",
  grinning: "😀",
  grin: "😁",
  joy: "😂",
  rofl: "🤣",
  wink: "😉",
  blush: "😊",
  sob: "😭",
  cry: "😢",
  sweat_smile: "😅",
  laughing: "😆",
  wave: "👋",
  clap: "👏",
  muscle: "💪",
  shrug: "🤷",
  facepalm: "🤦",
  zap: "⚡",
  heavy_check_mark: "✔️",
  ballot_box_with_check: "☑️",
  hankey: "💩",
  poo: "💩",
  lock: "🔒",
  unlock: "🔓",
  mag: "🔍",
  pencil2: "✏️",
  rotating_light: "🚨",
  hourglass: "⌛",
  hourglass_flowing_sand: "⏳",
  checkered_flag: "🏁",
  coffee: "☕",
  sunny: "☀️",
  computer: "💻",
  mind_blown: "🤯",
  point_up: "☝️",
  point_down: "👇",
  point_left: "👈",
  point_right: "👉",
  raised_hands: "🙌",
  boom: "💥",
  exclamation: "❗",
  question: "❓",
  no_entry_sign: "🚫",
  email: "✉️",
  mega: "📣",
  star2: "🌟",
  book: "📖",
  dart: "🎯",
};

const GROUP_SLUG_TO_CATEGORY: Readonly<Record<string, ReactionCategoryId>> = {
  smileys_emotion: "smileys_emotion",
  people_body: "people_body",
  animals_nature: "animals_nature",
  food_drink: "food_drink",
  travel_places: "travel_activities",
  activities: "travel_activities",
  objects: "objects",
  symbols: "symbols",
  flags: "flags",
};

const QUICK_BY_KEY = new Map<string, ReactionEmojiEntry>(
  QUICK_REACTIONS.map((entry) => [normalizeEmojiKey(entry.emoji), entry]),
);

const EXTRA_SHORTCODE_ALIASES_BY_KEY = new Map<string, string[]>();
for (const [alias, emoji] of Object.entries(EXTRA_SHORTCODE_ALIASES)) {
  const key = normalizeEmojiKey(emoji);
  const existing = EXTRA_SHORTCODE_ALIASES_BY_KEY.get(key);
  if (existing) {
    existing.push(alias);
  } else {
    EXTRA_SHORTCODE_ALIASES_BY_KEY.set(key, [alias]);
  }
}

function dedupeKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of keywords) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    result.push(trimmed);
  }
  return result;
}

function lookupEmojilibKeywords(emoji: string): readonly string[] {
  return (
    emojiKeywords[emoji]
    ?? emojiKeywords[normalizeEmojiKey(emoji)]
    ?? []
  );
}

let cachedCatalog: ReactionEmojiCatalog | undefined;

export function buildReactionEmojiCatalog(): ReactionEmojiCatalog {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  const byCategory: Record<ReactionCategoryId, ReactionEmojiEntry[]> = {
    quick: [...QUICK_REACTIONS],
    smileys_emotion: [],
    people_body: [],
    animals_nature: [],
    food_drink: [],
    travel_activities: [],
    objects: [],
    symbols: [],
    labels: [...LABEL_NUMBER_REACTIONS, ...LABEL_LETTER_REACTIONS],
    flags: [],
  };

  const all: ReactionEmojiEntry[] = [];
  const byKey = new Map<string, ReactionEmojiEntry>();
  const byShortcode = new Map<string, ReactionEmojiEntry>();

  const registerShortcode = (shortcode: string, entry: ReactionEmojiEntry): void => {
    const normalized = shortcode.trim().toLowerCase();
    if (!normalized || byShortcode.has(normalized)) {
      return;
    }
    byShortcode.set(normalized, entry);
  };

  for (const quick of QUICK_REACTIONS) {
    registerShortcode(quick.shortcode, quick);
  }

  const registerEntry = (entry: ReactionEmojiEntry, slug?: string): void => {
    const key = normalizeEmojiKey(entry.emoji);
    if (!byKey.has(key)) {
      byKey.set(key, entry);
      all.push(entry);
    }
    const canonical = byKey.get(key) ?? entry;
    registerShortcode(canonical.shortcode, canonical);
    if (slug) {
      registerShortcode(slug, canonical);
    }
  };

  for (const group of emojiGroups as UnicodeEmojiGroup[]) {
    const category = GROUP_SLUG_TO_CATEGORY[group.slug];
    if (!category) {
      continue;
    }
    for (const item of group.emojis) {
      const key = normalizeEmojiKey(item.emoji);
      const quickOverride = QUICK_BY_KEY.get(key);
      const libKeywords = lookupEmojilibKeywords(item.emoji);
      const extraKeywords =
        EXTRA_DEVELOPER_KEYWORDS[item.emoji]
        ?? EXTRA_DEVELOPER_KEYWORDS[key]
        ?? [];
      const extraAliases = EXTRA_SHORTCODE_ALIASES_BY_KEY.get(key) ?? [];
      const shortcode = quickOverride?.shortcode ?? item.slug;
      const keywords = dedupeKeywords([
        ...(quickOverride?.keywords ?? []),
        ...extraAliases,
        ...extraKeywords,
        ...libKeywords,
        item.slug,
      ]);
      const entry: ReactionEmojiEntry = {
        emoji: quickOverride?.emoji ?? item.emoji,
        name: quickOverride?.name ?? formatEmojiDisplayName(item.name),
        shortcode,
        category,
        keywords,
        ...(quickOverride ? { isQuick: true } : {}),
      };
      byCategory[category].push(entry);
      registerEntry(entry, item.slug);
    }
  }

  for (const entry of [...LABEL_NUMBER_REACTIONS, ...LABEL_LETTER_REACTIONS]) {
    const key = normalizeEmojiKey(entry.emoji);
    const existing = byKey.get(key);
    if (existing) {
      // Keep the label searchable by digit/letter aliases too.
      const merged: ReactionEmojiEntry = {
        ...existing,
        keywords: dedupeKeywords([...entry.keywords, ...existing.keywords]),
      };
      byKey.set(key, merged);
      const idx = all.indexOf(existing);
      if (idx >= 0) {
        all[idx] = merged;
      }
      registerShortcode(entry.shortcode, merged);
      for (const keyword of entry.keywords) {
        if (/^(?:keycap_\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)$/.test(keyword)) {
          registerShortcode(keyword, merged);
        }
      }
    } else {
      registerEntry(entry);
    }
  }

  for (const [alias, emoji] of Object.entries(EXTRA_SHORTCODE_ALIASES)) {
    const target = byKey.get(normalizeEmojiKey(emoji));
    if (target) {
      registerShortcode(alias, target);
    }
  }

  cachedCatalog = { all, byCategory, byKey, byShortcode };
  return cachedCatalog;
}

export function loadReactionEmojiCatalog(): Promise<ReactionEmojiCatalog> {
  return Promise.resolve(buildReactionEmojiCatalog());
}
