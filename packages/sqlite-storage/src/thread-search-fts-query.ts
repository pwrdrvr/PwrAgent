import { threadSearchTextTerms } from "@pwragent/shared/thread-search-query";

const MAX_FTS_TOKENS = 12;
const MAX_TYPO_TERMS = 2;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

type FtsTerm = { expression: string; word?: string };

function buildFtsTerms(raw: string | undefined): FtsTerm[] {
  const tokens = threadSearchTextTerms(raw ?? "").flatMap((term): FtsTerm[] => {
    const words = term.text.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
    return term.quoted
      ? words.length ? [{ expression: `"${words.join(" ")}"` }] : []
      : words.map((word) => ({ expression: `"${word}"*`, word }));
  });
  return [...new Map(tokens.map((token) => [token.expression, token])).values()].slice(0, MAX_FTS_TOKENS);
}

export function buildThreadSearchFtsQuery(raw: string | undefined): string | null {
  return buildFtsTerms(raw).map((term) => term.expression).join(" ") || null;
}

export function buildPartialThreadSearchFtsQuery(raw: string | undefined): string | undefined {
  const terms = buildFtsTerms(raw);
  const bare = terms.filter((term) => term.word !== undefined);
  const phrases = terms.filter((term) => term.word === undefined);
  if (bare.length === 0 || terms.length < 2) return undefined;

  // Every explicit phrase stays mandatory. With any phrases present, a
  // phrase alone is still evidence for a partial match.
  const relaxed = phrases.length > 0
    ? phrases.map((term) => term.expression).join(" ")
    : `(${bare.map((term) => term.expression).join(" OR ")})`;
  return `${relaxed} NOT (${terms.map((term) => term.expression).join(" ")})`;
}

function oneEditSpellings(word: string): string[] {
  const spellings = new Set<string>();
  for (let index = 0; index <= word.length; index++) {
    const prefix = word.slice(0, index);
    const suffix = word.slice(index);
    for (const letter of LETTERS) spellings.add(prefix + letter + suffix);
    if (index === word.length) break;
    const after = suffix.slice(1);
    spellings.add(prefix + after);
    for (const letter of LETTERS) spellings.add(prefix + letter + after);
    if (after) spellings.add(prefix + after[0] + suffix[0] + after.slice(1));
  }
  spellings.delete(word);
  return [...spellings];
}

export function buildTypoThreadSearchFtsQuery(raw: string | undefined): string | undefined {
  const terms = buildFtsTerms(raw);
  // Keep index work bounded. Exact variants are only useful for words long
  // enough that a single edit is discriminating. Paths, IDs, and explicit
  // phrases retain their literal behavior.
  const variants = terms
    .flatMap((term, index) => term.word && /^[a-z]{5,16}$/i.test(term.word)
      ? [{ word: term.word.toLowerCase(), index }]
      : [])
    .slice(0, MAX_TYPO_TERMS)
    .map(({ word, index }) => {
      const spellings = oneEditSpellings(word);
      const corrected = `(${spellings.map((spelling) => `"${spelling}"`).join(" OR ")})`;
      return `(${terms.map((term, at) => at === index ? corrected : term.expression).join(" AND ")})`;
    });

  return variants.length > 0 ? variants.join(" OR ") : undefined;
}
