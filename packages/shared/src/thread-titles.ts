const MAX_DERIVED_THREAD_TITLE_LENGTH = 72;
const MIN_PREFERRED_BREAK_INDEX = 36;

const LEADING_SKILL_LINK_RE = /^(?:\[\$[^\]]+\]\([^)]+\)\s*)+/i;
const LEADING_SKILL_TOKEN_RE = /^(?:\$[\w:-]+\s+)+/i;
const LEADING_REQUEST_PREFIX_RE =
  /^(?:i need(?: you to)?|can you|could you|would you|please|help me|let's|show me|tell me)\s+/i;

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[\s,;:.-]+$/g, "").trim();
}

function uppercaseFirstLetter(value: string): string {
  if (!value) {
    return value;
  }
  return value[0]!.toUpperCase() + value.slice(1);
}

function normalizeTitleInput(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }

  const withoutSkillLinks = trimmed.replace(LEADING_SKILL_LINK_RE, "");
  const withoutSkillTokens = withoutSkillLinks.replace(LEADING_SKILL_TOKEN_RE, "");
  return withoutSkillTokens || trimmed;
}

export function shortenDerivedThreadTitle(value: string | undefined): string | undefined {
  const normalized = normalizeTitleInput(value);
  if (!normalized) {
    return undefined;
  }

  const requestTrimmed = normalized.replace(LEADING_REQUEST_PREFIX_RE, "");
  const candidateBase =
    requestTrimmed && requestTrimmed.length < normalized.length
      ? uppercaseFirstLetter(requestTrimmed)
      : normalized;
  const candidate = trimTrailingPunctuation(candidateBase);

  if (candidate.length <= MAX_DERIVED_THREAD_TITLE_LENGTH) {
    return candidate;
  }

  const breakpointWindow = candidate.slice(0, MAX_DERIVED_THREAD_TITLE_LENGTH + 1);
  const punctuationBreaks = [
    breakpointWindow.lastIndexOf(". "),
    breakpointWindow.lastIndexOf("? "),
    breakpointWindow.lastIndexOf("! "),
    breakpointWindow.lastIndexOf(": "),
    breakpointWindow.lastIndexOf("; "),
    breakpointWindow.lastIndexOf(", "),
  ];
  const punctuationBreak = Math.max(...punctuationBreaks);
  if (punctuationBreak >= MIN_PREFERRED_BREAK_INDEX) {
    return `${trimTrailingPunctuation(candidate.slice(0, punctuationBreak))}...`;
  }

  const wordBreak = breakpointWindow.lastIndexOf(" ");
  if (wordBreak >= MIN_PREFERRED_BREAK_INDEX) {
    return `${trimTrailingPunctuation(candidate.slice(0, wordBreak))}...`;
  }

  return `${trimTrailingPunctuation(candidate.slice(0, MAX_DERIVED_THREAD_TITLE_LENGTH))}...`;
}
