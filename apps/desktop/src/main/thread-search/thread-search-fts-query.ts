const MAX_FTS_TOKENS = 12;

export function buildThreadSearchFtsQuery(raw: string | undefined): string | null {
  const text = raw?.trim();
  if (!text) {
    return null;
  }

  const tokens = text.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  const normalized = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))]
    .slice(0, MAX_FTS_TOKENS)
    .map((token) => `"${token.replace(/"/g, '""')}"*`);

  return normalized.length > 0 ? normalized.join(" ") : null;
}
