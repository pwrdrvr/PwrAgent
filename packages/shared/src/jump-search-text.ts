/** Match a prefix from each consecutive word, using at least two words. */
function wordPrefixesMatch(words: readonly string[], needle: string): boolean {
  let offsets = new Set([0]);
  for (let index = 0; index < words.length; index += 1) {
    const next = new Set<number>();
    const word = words[index]!.toLowerCase();
    for (const offset of offsets) {
      for (let length = 1; length <= word.length && offset + length <= needle.length; length += 1) {
        if (word[length - 1] !== needle[offset + length - 1]) break;
        if (offset + length === needle.length && index > 0) return true;
        next.add(offset + length);
      }
    }
    if (!next.size) return false;
    offsets = next;
  }
  return false;
}

function splitJumpWords(text: string): string[] {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Quick jump accepts word-prefix abbreviations as well as substrings:
 * PWS = Pw(r) S(uite) in PwrSuiteLab, PA = P(wr) A(gent), TS = trading-system.
 * Preserve source casing to find CamelCase boundaries; queries ignore case.
 * Path components are independent, so initials never span parent directories.
 */
export function textMatchesJumpQuery(text: string | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!text || !needle) return false;
  if (text.toLowerCase().includes(needle)) return true;
  if (!/^[\p{L}\p{N}]{2,32}$/u.test(needle)) return false;

  return text.split(/[\\/]/).some((component) => {
    // A compound within a title can match independently of surrounding prose.
    const compounds = component.match(/[\p{L}\p{N}]+(?:[-_.:][\p{L}\p{N}]+)*/gu) ?? [];
    return compounds.some((compound) => wordPrefixesMatch(splitJumpWords(compound), needle))
      || wordPrefixesMatch(splitJumpWords(component), needle);
  });
}
