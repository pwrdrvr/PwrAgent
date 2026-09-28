import { threadSearchTextTerms } from "@pwragent/shared";

const MAX_FTS_TOKENS = 12;

export function buildThreadSearchFtsQuery(raw: string | undefined): string | null {
  const text = raw?.trim();
  if (!text) {
    return null;
  }

  const tokens = threadSearchTextTerms(text).flatMap((term) => {
    const words = term.text.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
    return term.quoted
      ? words.length ? [`"${words.join(" ")}"`] : []
      : words.map((word) => `"${word}"*`);
  });
  const normalized = [...new Set(tokens)].slice(0, MAX_FTS_TOKENS);

  return normalized.length > 0 ? normalized.join(" ") : null;
}
