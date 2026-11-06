import { splitGraphemes } from "@pwragent/shared";

/**
 * How many trailing characters the branch row keeps when the name is too long
 * for one line. Twelve is enough to carry a trailing `-1.0` / short-sha style
 * discriminator plus the word before it, and — at the card's 11px mono — short
 * enough that the fixed tail can never outgrow the 244px content column.
 */
export const BRANCH_TAIL_CHARS = 12;

/** `full` is the name as one string; `head`/`tail` are the visual split only. */
export type PrBranch = { full: string; head: string; tail: string };

/**
 * Split the head branch for the CSS middle-truncation trick: only the `head`
 * span flexes, so the browser drops its ellipsis where the two halves meet
 * instead of at one end.
 *
 * Middle rather than either end is the whole point. Branch names on a thread
 * share BOTH a prefix (`claude/`, `agent/`) and, often, a suffix convention —
 * so start- or end-truncation can render two different branches identically,
 * which is exactly the confusion this row exists to remove.
 *
 * The cut is between grapheme clusters, not code points. macOS normalizes
 * filenames to NFD and a loose git ref IS a file, so `chore/déjà-vu-dedupe`
 * really does reach us with `a` followed by a separate U+0300. Cutting between
 * them drops the accent from the head (`déja`) and starts the tail with a bare
 * combining mark, which renders as a dotted circle or lands on the ellipsis.
 * ZWJ emoji tear the same way.
 *
 * Clusters also bound the tail's WIDTH, which the fixed `flex: 0 0 auto` tail
 * depends on: an arbitrarily long ZWJ sequence is still one glyph, so 12
 * clusters can never exceed roughly 12em.
 */
export function splitPrBranch(headRefName: string | undefined): PrBranch | undefined {
  const branch = headRefName?.trim();
  if (!branch) {
    return undefined;
  }
  const clusters = splitGraphemes(branch);
  // The tail never truncates, so never hand it more than half the name — on a
  // short branch a fixed 12 would swallow the whole string.
  const tailLength = Math.min(BRANCH_TAIL_CHARS, Math.floor(clusters.length / 2));
  if (tailLength <= 0) {
    return { full: branch, head: branch, tail: "" };
  }
  return {
    full: branch,
    head: clusters.slice(0, clusters.length - tailLength).join(""),
    tail: clusters.slice(clusters.length - tailLength).join(""),
  };
}
