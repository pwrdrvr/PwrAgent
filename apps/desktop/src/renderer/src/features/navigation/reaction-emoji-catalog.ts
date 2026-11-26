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

  const registerEntry = (entry: ReactionEmojiEntry): void => {
    const key = normalizeEmojiKey(entry.emoji);
    if (!byKey.has(key)) {
      byKey.set(key, entry);
      all.push(entry);
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
      const shortcode = quickOverride?.shortcode ?? item.slug;
      const keywords = dedupeKeywords([
        ...(quickOverride?.keywords ?? []),
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
      registerEntry(entry);
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
    } else {
      registerEntry(entry);
    }
  }

  cachedCatalog = { all, byCategory, byKey };
  return cachedCatalog;
}

export function loadReactionEmojiCatalog(): Promise<ReactionEmojiCatalog> {
  return Promise.resolve(buildReactionEmojiCatalog());
}
