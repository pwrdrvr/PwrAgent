/**
 * Boundary-aware text splitting shared by every provider adapter.
 *
 * Chat platforms cap a single message/edit (Slack section blocks at 3000
 * chars, Telegram at 4096 bytes, Discord at 2000 chars, …). A response longer
 * than the cap must be broken into several messages rather than silently
 * truncated. This helper does the breaking once, in one tested place, so each
 * adapter only has to say "my limit is N (chars|bytes)".
 *
 * Splitting prefers the cleanest boundary that keeps a chunk within the limit,
 * in this order: blank line (paragraph) → line → sentence end → word → hard
 * character cut (last resort, so a chunk is *always* produced even for an
 * unbroken run of characters). Rejoining the returned chunks reproduces the
 * text modulo whitespace collapsed at the cut points.
 */

export type MessageTextMeasure = "chars" | "bytes";

/** Size of `text` in the given unit. `chars` counts UTF-16 code units. */
export function measureMessageText(text: string, measure: MessageTextMeasure): number {
  return measure === "bytes" ? Buffer.byteLength(text, "utf8") : text.length;
}

/**
 * Split `text` into chunks each within `limit` units, breaking on the cleanest
 * available boundary. Returns `[]` for empty input and `[text]` when it already
 * fits. Every returned chunk is non-empty and within the limit.
 */
export function splitTextForDelivery(
  text: string,
  options: { limit: number; measure?: MessageTextMeasure },
): string[] {
  const measure = options.measure ?? "chars";
  const limit = Math.max(1, Math.floor(options.limit));
  const size = (value: string): number => measureMessageText(value, measure);

  if (!text) {
    return [];
  }
  if (size(text) <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;
  // Guard against a pathological non-shrinking loop (a cut of 0). The hard cut
  // below always makes progress, so this is belt-and-suspenders.
  while (rest.length > 0 && size(rest) > limit) {
    const cut = findCutIndex(rest, limit, size);
    const head = rest.slice(0, cut).replace(/\s+$/u, "");
    if (head) {
      chunks.push(head);
    }
    rest = rest.slice(cut).replace(/^\n+/u, "");
  }
  const tail = rest.replace(/\s+$/u, "");
  if (tail) {
    chunks.push(tail);
  }
  return chunks;
}

/**
 * Index at which to cut `text` so the prefix is within `limit`, preferring a
 * clean boundary. Always returns a value in `[1, text.length]` so the caller
 * makes progress.
 */
function findCutIndex(
  text: string,
  limit: number,
  size: (value: string) => number,
): number {
  const hardMax = maxPrefixLength(text, limit, size);
  if (hardMax >= text.length) {
    return text.length;
  }
  // Don't back up past the midpoint of the fitting window — a boundary far from
  // the limit wastes space and produces lots of tiny messages.
  const floor = Math.max(1, Math.floor(hardMax / 2));
  const window = text.slice(0, hardMax);

  // Blank line: cut AFTER the paragraph separator so the break lands between
  // paragraphs. `\n\n` (or more) — take the end of the run.
  const blank = lastMatchEnd(window, /\n{2,}/gu, floor);
  if (blank !== -1) {
    return blank;
  }
  // Single newline — cut after it.
  const newline = window.lastIndexOf("\n");
  if (newline >= floor) {
    return newline + 1;
  }
  // Sentence end followed by whitespace — cut after the whitespace.
  const sentence = lastMatchEnd(window, /[.!?…]["')\]]?\s+/gu, floor);
  if (sentence !== -1) {
    return sentence;
  }
  // Word boundary — cut after the last space.
  const space = window.lastIndexOf(" ");
  if (space >= floor) {
    return space + 1;
  }
  // No usable boundary — hard cut at the limit.
  return hardMax;
}

/** Largest prefix length of `text` whose size is within `limit`. */
function maxPrefixLength(
  text: string,
  limit: number,
  size: (value: string) => number,
): number {
  // Fast path for char measure: 1 code unit ≈ 1 unit, but surrogate pairs make
  // slicing mid-pair invalid, so still verify. Binary search keeps bytes cheap.
  let low = 1;
  let high = text.length;
  let best = 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    // Avoid splitting a surrogate pair: pull the index back off a low surrogate.
    const idx = avoidSurrogateSplit(text, mid);
    if (idx >= 1 && size(text.slice(0, idx)) <= limit) {
      best = idx;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** If `index` falls between a surrogate pair, move it back before the pair. */
function avoidSurrogateSplit(text: string, index: number): number {
  if (index <= 0 || index >= text.length) {
    return index;
  }
  const code = text.charCodeAt(index);
  // 0xDC00–0xDFFF is a low surrogate: the char at index-1 is its high half.
  if (code >= 0xdc00 && code <= 0xdfff) {
    return index - 1;
  }
  return index;
}

/**
 * End index of the last match of `pattern` in `text` whose end is at or after
 * `floor`, or -1 if none. `pattern` must be a global regex.
 */
function lastMatchEnd(text: string, pattern: RegExp, floor: number): number {
  let end = -1;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const matchEnd = match.index + match[0].length;
    if (matchEnd >= floor) {
      end = matchEnd;
    }
    // Prevent zero-width infinite loops.
    if (match.index === pattern.lastIndex) {
      pattern.lastIndex += 1;
    }
  }
  return end;
}
