import {
  BASE_REACTION_ENTRIES,
  QUICK_REACTIONS,
  createLazyValueCache,
  normalizeEmojiKey,
  searchReactionEmojis,
  type ReactionEmojiEntry,
} from "../features/navigation/reaction-picker-model";
import type { ReactionEmojiCatalog } from "../features/navigation/reaction-emoji-catalog";

export const EMOJI_AUTOCOMPLETE_LIMIT = 8;

export type EmojiShortcodeTrigger = {
  start: number;
  end: number;
  query: string;
};

export type EmojiShortcodeMatch = {
  start: number;
  end: number;
  shortcode: string;
  entry: ReactionEmojiEntry;
};

const SHORTCODE_BODY_PATTERN = /^[A-Za-z0-9_+-]{1,64}$/;
const SHORTCODE_CANDIDATE_PATTERN = /:([A-Za-z0-9_+-]{1,64}):/g;
const POTENTIAL_SHORTCODE_PATTERN = /:[A-Za-z0-9_+-]{1,64}:/;
const TRAILING_PUNCTUATION_PATTERN = /^[.,!?;)]$/;

const emojiCatalogCache = createLazyValueCache<ReactionEmojiCatalog>(() =>
  import("../features/navigation/reaction-emoji-catalog").then((module) =>
    module.loadReactionEmojiCatalog(),
  ),
);

const BASE_BY_KEY = new Map<string, ReactionEmojiEntry>(
  BASE_REACTION_ENTRIES.map((entry) => [normalizeEmojiKey(entry.emoji), entry]),
);

const BASE_SHORTCODE_ALIASES: Readonly<Record<string, string>> = {
  thumbsup: "👍",
  thumbs_up: "👍",
  thumbsdown: "👎",
  thumbs_down: "👎",
  check_mark_button: "✅",
  cross_mark: "❌",
  party_popper: "🎉",
  red_heart: "❤️",
  thinking_face: "🤔",
  light_bulb: "💡",
  folded_hands: "🙏",
  face_screaming_in_fear: "😱",
  pile_of_poo: "💩",
  poo: "💩",
  hankey: "💩",
};

const BASE_BY_SHORTCODE: ReadonlyMap<string, ReactionEmojiEntry> = (() => {
  const map = new Map<string, ReactionEmojiEntry>();
  const register = (shortcode: string, entry: ReactionEmojiEntry): void => {
    const normalized = shortcode.trim().toLowerCase();
    if (!normalized || map.has(normalized)) {
      return;
    }
    map.set(normalized, entry);
  };

  for (const entry of QUICK_REACTIONS) {
    register(entry.shortcode, entry);
  }
  for (const [alias, emoji] of Object.entries(BASE_SHORTCODE_ALIASES)) {
    const entry = BASE_BY_KEY.get(normalizeEmojiKey(emoji));
    if (entry) {
      register(alias, entry);
    }
  }
  for (const entry of BASE_REACTION_ENTRIES) {
    register(entry.shortcode, entry);
    for (const keyword of entry.keywords) {
      if (/^(?:keycap_\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)$/.test(keyword)) {
        register(keyword, entry);
      }
    }
  }
  return map;
})();

export function getCachedEmojiCatalog(): ReactionEmojiCatalog | undefined {
  return emojiCatalogCache.getCached();
}

export function loadEmojiCatalog(): Promise<ReactionEmojiCatalog> {
  return emojiCatalogCache.load();
}

export function preloadEmojiCatalog(): void {
  if (emojiCatalogCache.getCached()) {
    return;
  }
  void emojiCatalogCache.load().catch(() => {
    // Base entries remain available; the next request retries the lazy chunk.
  });
}

export function resolveEmojiShortcode(
  shortcode: string,
  catalog?: ReactionEmojiCatalog,
): ReactionEmojiEntry | undefined {
  if (!SHORTCODE_BODY_PATTERN.test(shortcode)) {
    return undefined;
  }
  const normalized = shortcode.toLowerCase();
  const activeCatalog = catalog ?? emojiCatalogCache.getCached();
  return activeCatalog?.byShortcode.get(normalized) ?? BASE_BY_SHORTCODE.get(normalized);
}

export function searchEmojiShortcodes(
  query: string,
  catalog?: ReactionEmojiCatalog,
  limit = EMOJI_AUTOCOMPLETE_LIMIT,
): ReactionEmojiEntry[] {
  if (!SHORTCODE_BODY_PATTERN.test(query)) {
    return [];
  }
  const source = (catalog ?? emojiCatalogCache.getCached())?.all ?? BASE_REACTION_ENTRIES;
  return searchReactionEmojis(source, query, limit);
}

export function hasPotentialEmojiShortcode(text: string): boolean {
  return text.includes(":") && POTENTIAL_SHORTCODE_PATTERN.test(text);
}

function parseOpeningFence(line: string): { char: "`" | "~"; length: number } | undefined {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  const marker = match[1]!;
  const info = match[2] ?? "";
  if (marker[0] === "`" && info.includes("`")) {
    return undefined;
  }
  return {
    char: marker[0] as "`" | "~",
    length: marker.length,
  };
}

function isClosingFence(
  line: string,
  fence: { char: "`" | "~"; length: number },
): boolean {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!match) {
    return false;
  }
  const marker = match[1]!;
  return marker[0] === fence.char && marker.length >= fence.length;
}

function hasUnclosedInlineCodeSpan(line: string): boolean {
  let openTicks = 0;
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\\" && openTicks === 0) {
      index += 2;
      continue;
    }
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let run = 0;
    while (index + run < line.length && line[index + run] === "`") {
      run += 1;
    }
    if (openTicks === 0) {
      openTicks = run;
    } else if (openTicks === run) {
      openTicks = 0;
    }
    index += run;
  }
  return openTicks > 0;
}

/**
 * Returns true when `caret` sits inside an unclosed fenced code block or an
 * unclosed inline backtick code span in `text`.
 */
export function isInsideUnclosedCodeContext(
  text: string,
  caret: number,
): boolean {
  const prefix = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const lines = prefix.split(/\r?\n/);
  let activeFence: { char: "`" | "~"; length: number } | undefined;

  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!;
    if (activeFence) {
      if (isClosingFence(line, activeFence)) {
        activeFence = undefined;
      }
    } else {
      activeFence = parseOpeningFence(line);
    }
  }

  if (activeFence) {
    return true;
  }

  const currentLine = lines[lines.length - 1] ?? "";
  if (parseOpeningFence(currentLine)) {
    return true;
  }
  return hasUnclosedInlineCodeSpan(currentLine);
}

function hasValidLeadingBoundary(
  text: string,
  colonIndex: number,
  allowStart: boolean,
  allowOpeningParen: boolean,
): boolean {
  if (colonIndex === 0) {
    return allowStart;
  }
  const prev = text[colonIndex - 1]!;
  if (/\s/.test(prev)) {
    return true;
  }
  if (allowOpeningParen && prev === "(") {
    if (colonIndex === 1) {
      return allowStart;
    }
    return /\s/.test(text[colonIndex - 2]!);
  }
  return false;
}

function hasValidTrailingBoundary(
  text: string,
  endIndex: number,
  allowEnd: boolean,
): boolean {
  if (endIndex >= text.length) {
    return allowEnd;
  }
  const next = text[endIndex]!;
  return /\s/.test(next) || TRAILING_PUNCTUATION_PATTERN.test(next);
}

/**
 * Finds an active `:shortcode` prefix at `caret` for composer autocomplete.
 * Requires start of line or whitespace immediately before `:` and at least one
 * valid shortcode character after `:`, while skipping unclosed code contexts.
 */
export function findEmojiShortcodeTrigger(
  text: string,
  caret: number,
  options?: {
    atLineStart?: boolean;
    getPriorText?: () => string | undefined;
    priorText?: string;
  },
): EmojiShortcodeTrigger | undefined {
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  const prefix = text.slice(0, safeCaret);
  const match = /:([A-Za-z0-9_+-]{1,64})$/.exec(prefix);
  if (!match) {
    return undefined;
  }
  const start = prefix.length - match[0].length;
  const allowStart = options?.atLineStart !== false;
  if (!hasValidLeadingBoundary(prefix, start, allowStart, false)) {
    return undefined;
  }
  const priorText = options?.priorText ?? options?.getPriorText?.();
  const codeContextText = priorText
    ? `${priorText}\n${prefix}`
    : prefix;
  if (isInsideUnclosedCodeContext(codeContextText, codeContextText.length)) {
    return undefined;
  }
  return {
    start,
    end: safeCaret,
    query: match[1]!,
  };
}

/**
 * Matches a complete known `:shortcode:` when the operator types the closing
 * `:` at the boundary between `prefix` and `suffix`.
 */
export function findExactEmojiShortcodeBeforeColon(
  prefix: string,
  suffix: string,
  options?: {
    atLineStart?: boolean;
    catalog?: ReactionEmojiCatalog;
    getPriorText?: () => string | undefined;
    priorText?: string;
  },
): EmojiShortcodeMatch | undefined {
  const match = /:([A-Za-z0-9_+-]{1,64})$/.exec(prefix);
  if (!match) {
    return undefined;
  }
  const start = prefix.length - match[0].length;
  const allowStart = options?.atLineStart !== false;
  if (!hasValidLeadingBoundary(prefix, start, allowStart, true)) {
    return undefined;
  }
  if (!hasValidTrailingBoundary(suffix, 0, true)) {
    return undefined;
  }
  const shortcode = match[1]!;
  const entry = resolveEmojiShortcode(shortcode, options?.catalog);
  if (!entry) {
    return undefined;
  }
  const priorText = options?.priorText ?? options?.getPriorText?.();
  const codeContextText = priorText
    ? `${priorText}\n${prefix}`
    : prefix;
  if (isInsideUnclosedCodeContext(codeContextText, codeContextText.length)) {
    return undefined;
  }
  return {
    start,
    end: prefix.length,
    shortcode,
    entry,
  };
}

/**
 * Replaces known boundary-safe `:shortcode:` tokens inside prose text with
 * their Unicode emoji characters. Unknown shortcodes, `::` operators, URLs,
 * timestamps, and non-boundary colons remain untouched.
 */
export function replaceEmojiShortcodesInText(
  text: string,
  options?: {
    catalog?: ReactionEmojiCatalog;
    allowLeadingStart?: boolean;
    allowTrailingEnd?: boolean;
  },
): string {
  if (!text.includes(":")) {
    return text;
  }
  const allowLeadingStart = options?.allowLeadingStart !== false;
  const allowTrailingEnd = options?.allowTrailingEnd !== false;

  SHORTCODE_CANDIDATE_PATTERN.lastIndex = 0;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = SHORTCODE_CANDIDATE_PATTERN.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const shortcode = match[1]!;

    if (!hasValidLeadingBoundary(text, start, allowLeadingStart, true)) {
      continue;
    }
    if (!hasValidTrailingBoundary(text, end, allowTrailingEnd)) {
      continue;
    }

    const entry = resolveEmojiShortcode(shortcode, options?.catalog);
    if (!entry) {
      continue;
    }

    output += text.slice(cursor, start) + entry.emoji;
    cursor = end;
  }

  if (cursor === 0) {
    return text;
  }
  return output + text.slice(cursor);
}
