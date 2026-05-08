export const MESSAGING_CONTACT_LABEL_MAX_LENGTH = 64;

const RAW_CONTACT_LABEL_MAX_LENGTH = 512;
const SAFE_CONTACT_LABEL_PUNCTUATION = new Set([
  " ",
  ".",
  "_",
  "-",
  "+",
  "@",
  "(",
  ")",
]);
const BLOCKED_FORMAT_CHARS = new Set([
  "\u061c",
  "\u200b",
  "\u200c",
  "\u200d",
  "\u200e",
  "\u200f",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
  "\u2060",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
  "\ufeff",
]);

/**
 * Contact labels are provider/user-controlled data. Store only plain text that
 * is safe to render as text and safe to carry through config/database layers.
 */
export function sanitizeMessagingContactLabel(value: unknown): string {
  if (typeof value !== "string") return "";

  const normalized = stripHtmlLikeMarkup(
    value.slice(0, RAW_CONTACT_LABEL_MAX_LENGTH),
  ).normalize("NFKC");
  const result: string[] = [];
  let lastWasSpace = false;

  for (const char of normalized) {
    if (result.length >= MESSAGING_CONTACT_LABEL_MAX_LENGTH) break;

    const codePoint = char.codePointAt(0) ?? 0;
    if (
      isBlockedContactLabelCodePoint(codePoint)
      || BLOCKED_FORMAT_CHARS.has(char)
      || !isAllowedContactLabelChar(char)
    ) {
      continue;
    }

    if (char === " ") {
      if (!lastWasSpace && result.length > 0) {
        result.push(char);
      }
      lastWasSpace = true;
      continue;
    }

    result.push(char);
    lastWasSpace = false;
  }

  return result.join("").replace(/-{2,}/g, "-").trim();
}

export function sanitizeMessagingContactHandle(value: unknown): string {
  return sanitizeMessagingContactLabel(value)
    .replace(/^@+/, "")
    .replace(/\s+/g, "");
}

function stripHtmlLikeMarkup(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
}

function isAllowedContactLabelChar(char: string): boolean {
  return /^[\p{L}\p{N}\p{M}]$/u.test(char)
    || SAFE_CONTACT_LABEL_PUNCTUATION.has(char);
}

function isBlockedContactLabelCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    || (codePoint >= 0xe000 && codePoint <= 0xf8ff)
    || (codePoint >= 0xf0000 && codePoint <= 0xffffd)
    || (codePoint >= 0x100000 && codePoint <= 0x10fffd);
}
