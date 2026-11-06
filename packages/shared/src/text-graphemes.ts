/**
 * Cut display text without tearing a character.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a plain cut can land
 * inside an emoji's surrogate pair (the half renders as U+FFFD), between a
 * letter and its NFD combining accent (`déjà` → `deja` plus a stray mark), or
 * inside a ZWJ sequence (`👩‍💻` → `👩‍`). These helpers keep each budget in
 * code units, as the callers already measure it, but move every cut back to a
 * grapheme cluster boundary: what a reader calls a character.
 */

let segmenter: Intl.Segmenter | undefined;

/** Grapheme clusters in order, lazily, falling back to code points. */
function* clusters(value: string): Generator<string> {
  if (typeof Intl.Segmenter !== "function") {
    yield* value;
    return;
  }
  // Fixed locale: cluster boundaries are effectively locale-invariant, and
  // pinning it keeps the split identical on every operator's machine.
  segmenter ??= new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(value)) {
    yield segment;
  }
}

/** Split into grapheme clusters, falling back to code points. */
export function splitGraphemes(value: string): string[] {
  return Array.from(clusters(value));
}

/** The longest run of whole leading clusters whose length is at most `maxLength`. */
export function graphemePrefix(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  // Lazy: a long prompt is segmented only as far as the budget reaches.
  let end = 0;
  for (const cluster of clusters(value)) {
    if (end + cluster.length > maxLength) {
      break;
    }
    end += cluster.length;
  }
  return value.slice(0, end);
}

/** The longest run of whole trailing clusters whose length is at most `maxLength`. */
export function graphemeSuffix(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const clusters = splitGraphemes(value);
  let start = value.length;
  for (let index = clusters.length - 1; index >= 0; index -= 1) {
    const length = clusters[index]!.length;
    if (value.length - start + length > maxLength) {
      break;
    }
    start -= length;
  }
  return value.slice(start);
}
