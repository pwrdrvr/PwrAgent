const CANONICAL_PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED_PROFILE_NAMES = new Set(["con", "nul", "aux", "prn", ".", ".."]);

export function normalizeProfileName(value: string): string {
  const trimmed = value.trim();
  if (
    CANONICAL_PROFILE_NAME_REGEX.test(trimmed) &&
    !RESERVED_PROFILE_NAMES.has(trimmed)
  ) {
    return trimmed;
  }

  const normalized = trimmed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32)
    .replace(/[-_]+$/g, "");

  if (!normalized) {
    return "";
  }

  if (RESERVED_PROFILE_NAMES.has(normalized)) {
    return `${normalized}-profile`;
  }

  return normalized;
}

export function isCanonicalProfileName(value: string): boolean {
  return (
    CANONICAL_PROFILE_NAME_REGEX.test(value) &&
    !RESERVED_PROFILE_NAMES.has(value) &&
    normalizeProfileName(value) === value
  );
}
