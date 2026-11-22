import { normalizeProfileName } from "./provisionPairedProfiles";

/** The most new paired profiles one guided run creates. */
export const MAX_NEW_CODEX_PROFILES = 5;

/**
 * Why one row's name can't be created, or `undefined` when it can. A blank
 * row has no problem; it is simply not created. `existingProfiles` are the
 * PwrAgent profiles already on this computer: creating one of those would
 * fail in main, after the operator had already signed it in.
 */
export function describeProfileNameProblem(
  raw: string,
  allRows: readonly string[],
  existingProfiles: readonly string[],
): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const normalized = normalizeProfileName(trimmed);
  if (!normalized) {
    return "Use lowercase letters, digits, _ or -, starting with a letter or digit.";
  }
  if (existingProfiles.includes(normalized)) {
    return `A profile named ${normalized} already exists.`;
  }
  const sameName = allRows.filter(
    (row) => row.trim() && normalizeProfileName(row) === normalized,
  );
  if (sameName.length > 1) return `Two rows are both named ${normalized}.`;
  return undefined;
}

/**
 * The names to create, normalized, when every row is acceptable and there
 * are 1 to 5 of them; otherwise `undefined`.
 */
export function newProfileNamesToCreate(
  rows: readonly string[],
  existingProfiles: readonly string[],
): string[] | undefined {
  const named = rows.filter((row) => row.trim().length > 0);
  if (named.length < 1 || named.length > MAX_NEW_CODEX_PROFILES) return undefined;
  if (named.some((row) => describeProfileNameProblem(row, rows, existingProfiles))) {
    return undefined;
  }
  return named.map((row) => normalizeProfileName(row));
}
