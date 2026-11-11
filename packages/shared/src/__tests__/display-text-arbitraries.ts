import fc from "fast-check";
import { expect } from "vitest";

/**
 * Display text built from the pieces that tear when a cut counts UTF-16 code
 * units: surrogate pairs, NFD combining accents (macOS file names and git
 * refs reach us this way), ZWJ emoji and flags, beside ordinary words, CJK,
 * punctuation and whitespace. Shared by the truncation property tests in
 * shared, owner-core and the desktop renderer.
 */
const PIECES = [
  "a", "Z", "fix", "branch", "/", "-", "_", ".", ",", ":", ";", "!", "?", "(", ")",
  " ", " ", " ", "  ", "\t", "\n",
  "e\u0301", "de\u0301ja\u0300", "n\u0303",
  "😀", "𝒳", "🇺🇸", "👍🏽", "👩\u200d💻", "👨\u200d👩\u200d👧\u200d👦",
  "日本", "한",
] as const;

export const displayPiece = fc.constantFrom(...PIECES);

/** Text up to about `maxPieces` pieces long, so both sides of a budget appear. */
export function displayText(maxPieces = 60): fc.Arbitrary<string> {
  return fc.array(displayPiece, { maxLength: maxPieces, size: "max" }).map((pieces) => pieces.join(""));
}

/**
 * Text whose length straddles `limit`: a run of letters up to just short of
 * it, then a few display pieces, so the cut lands among the pieces that
 * tear. Random text alone rarely reaches a 72- or 160-character limit with an
 * emoji or accent right at the cut. The run has no spaces, so word-boundary
 * helpers reach their hard cut too.
 */
export function displayTextNear(limit: number): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.string({
        unit: fc.constantFrom("a", "b"),
        minLength: Math.max(0, limit - 8),
        maxLength: limit + 2,
      }),
      displayText(6),
    )
    .map(([filler, tail]) => filler + tail);
}

/** Random display text, half of it near `limit`. */
export function displayTextAround(limit: number, maxPieces = 60): fc.Arbitrary<string> {
  return fc.oneof(displayText(maxPieces), displayTextNear(limit));
}

/** Whitespace only, which trimming helpers must treat as empty. */
export const whitespaceText = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r\n"), { minLength: 1, maxLength: 8 })
  .map((pieces) => pieces.join(""));

const ORACLE_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Offsets in `value` where a grapheme cluster starts or the string ends. The
 * oracle is `Intl.Segmenter` itself, not the code under test.
 */
export function clusterBoundaries(value: string): Set<number> {
  const boundaries = new Set<number>([value.length]);
  for (const { index } of ORACLE_SEGMENTER.segment(value)) {
    boundaries.add(index);
  }
  return boundaries;
}

// No `u` flag: with it, a valid pair reads as one code point and never matches.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A torn surrogate pair, which renders as U+FFFD. */
export function hasLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE.test(value);
}

/** `kept` is `source`'s leading text, cut on a cluster boundary. */
export function expectClusterPrefix(kept: string, source: string): void {
  expect(source.startsWith(kept)).toBe(true);
  expect(clusterBoundaries(source).has(kept.length)).toBe(true);
}

/** `kept` is `source`'s trailing text, cut on a cluster boundary. */
export function expectClusterSuffix(kept: string, source: string): void {
  expect(source.endsWith(kept)).toBe(true);
  expect(clusterBoundaries(source).has(source.length - kept.length)).toBe(true);
}

type CutRules = {
  /** The marker the helper puts where text was removed. */
  ellipsis: string;
  /**
   * The longest the output may be: ellipsis included, unless
   * `ellipsisOutsideBudget` says the budget counts only the kept text.
   */
  maxLength: number;
  ellipsisOutsideBudget?: boolean;
};

function outputBudget(rules: CutRules): number {
  return rules.maxLength + (rules.ellipsisOutsideBudget ? rules.ellipsis.length : 0);
}

/**
 * The rules every end-truncating helper promises: text that fits comes back
 * unchanged; otherwise the output is a cluster-aligned prefix of the input
 * plus the ellipsis, within budget.
 */
export function expectEndCut(source: string, output: string, rules: CutRules): void {
  if (source.length <= rules.maxLength) {
    expect(output).toBe(source);
    return;
  }
  expect(output.length).toBeLessThanOrEqual(outputBudget(rules));
  expect(output.endsWith(rules.ellipsis)).toBe(true);
  expectClusterPrefix(output.slice(0, output.length - rules.ellipsis.length), source);
}

/**
 * The same rules for a middle elision: the output is a cluster-aligned
 * prefix, the ellipsis, then a cluster-aligned suffix. The input may itself
 * contain the marker (`...`), so any split that satisfies the rule counts.
 */
export function expectMiddleCut(source: string, output: string, rules: CutRules): void {
  if (source.length <= rules.maxLength) {
    expect(output).toBe(source);
    return;
  }
  expect(output.length).toBeLessThanOrEqual(outputBudget(rules));
  const boundaries = clusterBoundaries(source);
  let found = false;
  for (let index = output.indexOf(rules.ellipsis); index >= 0 && !found; index = output.indexOf(rules.ellipsis, index + 1)) {
    const head = output.slice(0, index);
    const tail = output.slice(index + rules.ellipsis.length);
    found = source.startsWith(head)
      && source.endsWith(tail)
      && head.length + tail.length < source.length
      && boundaries.has(head.length)
      && boundaries.has(source.length - tail.length);
  }
  expect(found, `${JSON.stringify(output)} is not a clean elision of ${JSON.stringify(source)}`).toBe(true);
}
