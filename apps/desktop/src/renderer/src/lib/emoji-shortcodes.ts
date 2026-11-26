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
const TRAILING_PUNCTUATION_PATTERN = /^[.,!?;)]$/;
const MAX_SHORTCODE_LENGTH = 64;

function isShortcodeBodyChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) // a-z
    || (code >= 65 && code <= 90) // A-Z
    || (code >= 48 && code <= 57) // 0-9
    || code === 95 // _
    || code === 43 // +
    || code === 45 // -
  );
}

/**
 * Scans backward at most `MAX_SHORTCODE_LENGTH + 1` characters from `endOffset`
 * in `text` to find a `:shortcode` candidate ending right at `endOffset`.
 * Runs in strictly O(1) time regardless of `text.length`.
 */
function scanShortcodeSuffix(
  text: string,
  endOffset: number,
): { start: number; shortcode: string } | undefined {
  let cursor = endOffset;
  const minCursor = Math.max(0, endOffset - MAX_SHORTCODE_LENGTH);
  while (cursor > minCursor && isShortcodeBodyChar(text.charCodeAt(cursor - 1))) {
    cursor -= 1;
  }
  if (cursor === endOffset || cursor === 0 || text.charCodeAt(cursor - 1) !== 58 /* : */) {
    return undefined;
  }
  const start = cursor - 1;
  return {
    start,
    shortcode: text.slice(cursor, endOffset),
  };
}

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

export type CodeFenceMarker = {
  char: "`" | "~";
  length: number;
  canClose: boolean;
};

/**
 * Extracts only the CommonMark fence-opening or fence-closing lines from `text`
 * so callers can cache fence transitions per immutable document block.
 */
export function extractCodeFenceMarkers(text: string): readonly CodeFenceMarker[] {
  if (!text.includes("```") && !text.includes("~~~")) {
    return EMPTY_FENCE_MARKERS;
  }
  const lines = text.split(/\r?\n/);
  const markers: CodeFenceMarker[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const closingMatch = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (closingMatch) {
      const token = closingMatch[1]!;
      markers.push({
        char: token[0] as "`" | "~",
        length: token.length,
        canClose: true,
      });
      continue;
    }
    const opening = parseOpeningFence(line);
    if (opening) {
      markers.push({
        char: opening.char,
        length: opening.length,
        canClose: false,
      });
    }
  }
  return markers.length > 0 ? markers : EMPTY_FENCE_MARKERS;
}

const EMPTY_FENCE_MARKERS: readonly CodeFenceMarker[] = [];

export function advanceCodeFenceState(
  activeFence: { char: "`" | "~"; length: number } | undefined,
  markers: readonly CodeFenceMarker[],
): { char: "`" | "~"; length: number } | undefined {
  let state = activeFence;
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]!;
    if (state) {
      if (marker.canClose && marker.char === state.char && marker.length >= state.length) {
        state = undefined;
      }
    } else {
      state = { char: marker.char, length: marker.length };
    }
  }
  return state;
}

export function isCurrentLineInsideUnclosedCode(line: string): boolean {
  return Boolean(parseOpeningFence(line)) || hasUnclosedInlineCodeSpan(line);
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
  return isCurrentLineInsideUnclosedCode(currentLine);
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
    getCurrentLine?: () => string;
    getPriorText?: () => string | undefined;
    isInsidePriorFence?: () => boolean;
    priorText?: string;
  },
): EmojiShortcodeTrigger | undefined {
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  const candidate = scanShortcodeSuffix(text, safeCaret);
  if (!candidate) {
    return undefined;
  }
  const allowStart = options?.atLineStart !== false;
  if (!hasValidLeadingBoundary(text, candidate.start, allowStart, false)) {
    return undefined;
  }
  if (options?.isInsidePriorFence) {
    if (options.isInsidePriorFence()) {
      return undefined;
    }
    const line = options.getCurrentLine
      ? options.getCurrentLine()
      : text.slice(text.lastIndexOf("\n", safeCaret - 1) + 1, safeCaret);
    if (isCurrentLineInsideUnclosedCode(line)) {
      return undefined;
    }
  } else {
    const prefix = text.slice(0, safeCaret);
    const priorText = options?.priorText ?? options?.getPriorText?.();
    const currentLine = options?.getCurrentLine ? options.getCurrentLine() : prefix;
    const codeContextText = priorText
      ? `${priorText}\n${currentLine}`
      : currentLine;
    if (isInsideUnclosedCodeContext(codeContextText, codeContextText.length)) {
      return undefined;
    }
  }
  return {
    start: candidate.start,
    end: safeCaret,
    query: candidate.shortcode,
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
    getCurrentLine?: () => string;
    getPriorText?: () => string | undefined;
    isInsidePriorFence?: () => boolean;
    priorText?: string;
  },
): EmojiShortcodeMatch | undefined {
  const candidate = scanShortcodeSuffix(prefix, prefix.length);
  if (!candidate) {
    return undefined;
  }
  const allowStart = options?.atLineStart !== false;
  if (!hasValidLeadingBoundary(prefix, candidate.start, allowStart, true)) {
    return undefined;
  }
  if (!hasValidTrailingBoundary(suffix, 0, true)) {
    return undefined;
  }
  const entry = resolveEmojiShortcode(candidate.shortcode, options?.catalog);
  if (!entry) {
    return undefined;
  }
  if (options?.isInsidePriorFence) {
    if (options.isInsidePriorFence()) {
      return undefined;
    }
    const line = options.getCurrentLine
      ? options.getCurrentLine()
      : prefix.slice(prefix.lastIndexOf("\n") + 1);
    if (isCurrentLineInsideUnclosedCode(line)) {
      return undefined;
    }
  } else {
    const priorText = options?.priorText ?? options?.getPriorText?.();
    const currentLine = options?.getCurrentLine ? options.getCurrentLine() : prefix;
    const codeContextText = priorText
      ? `${priorText}\n${currentLine}`
      : currentLine;
    if (isInsideUnclosedCodeContext(codeContextText, codeContextText.length)) {
      return undefined;
    }
  }
  return {
    start: candidate.start,
    end: prefix.length,
    shortcode: candidate.shortcode,
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
    onMissingCatalog?: () => void;
  },
): string {
  let colonIndex = text.indexOf(":");
  if (colonIndex === -1) {
    return text;
  }
  const allowLeadingStart = options?.allowLeadingStart !== false;
  const allowTrailingEnd = options?.allowTrailingEnd !== false;
  const activeCatalog = options?.catalog ?? emojiCatalogCache.getCached();
  const onMissingCatalog = !activeCatalog ? options?.onMissingCatalog : undefined;

  let output = "";
  let cursor = 0;

  while (colonIndex !== -1) {
    if (!hasValidLeadingBoundary(text, colonIndex, allowLeadingStart, true)) {
      colonIndex = text.indexOf(":", colonIndex + 1);
      continue;
    }

    let scan = colonIndex + 1;
    const maxEnd = Math.min(text.length, scan + MAX_SHORTCODE_LENGTH);
    while (scan < maxEnd && isShortcodeBodyChar(text.charCodeAt(scan))) {
      scan += 1;
    }

    if (scan === colonIndex + 1 || scan >= text.length || text.charCodeAt(scan) !== 58 /* : */) {
      colonIndex = text.indexOf(":", scan);
      continue;
    }

    const end = scan + 1;
    if (!hasValidTrailingBoundary(text, end, allowTrailingEnd)) {
      // `scan` is preceded by a shortcode body char, so it can never be a valid
      // leading boundary for a subsequent shortcode.
      colonIndex = text.indexOf(":", end);
      continue;
    }

    const shortcode = text.slice(colonIndex + 1, scan);
    const entry = resolveEmojiShortcode(shortcode, activeCatalog);
    if (!entry) {
      onMissingCatalog?.();
      colonIndex = text.indexOf(":", end);
      continue;
    }

    output += text.slice(cursor, colonIndex) + entry.emoji;
    cursor = end;
    colonIndex = text.indexOf(":", end);
  }

  if (cursor === 0) {
    return text;
  }
  return output + text.slice(cursor);
}
