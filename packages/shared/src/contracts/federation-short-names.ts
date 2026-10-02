/**
 * Federation instance short names.
 *
 * Host labels ("Studio-MBP-M5-Max", "DESKTOP-17ISFOI") ellipsize wherever an
 * instance is drawn small: the Federation popover's Star Map bodies, Star Map
 * instance cards, the Activity window's peer chips. The root gateway asks a
 * helper model for one short name per machine, checks the answer by rule,
 * and shares the map over federation, so every instance shows the same
 * names. Tooltips, accessible names, menus, Settings and anything an agent
 * reads keep the full label.
 *
 * The map travels and merges exactly like the celestial icon assignments:
 * one entry per instance, last-writer-wins by `updatedAt`, operator
 * overrides, tombstones for revoked instances.
 */

/** A label this short is already short; it is used as-is, with no model call. */
export const FEDERATION_SHORT_NAME_KEEP_LENGTH = 10;

/** The longest short name the validator accepts, in code points. */
export const FEDERATION_SHORT_NAME_MAX_LENGTH = 12;

/**
 * Upper bound on how many entries an instance accepts and persists, for the
 * same reason as `MAX_CELESTIAL_ASSIGNMENTS`: an LWW map otherwise grows
 * without limit when a buggy peer streams fabricated instance ids.
 */
export const MAX_FEDERATION_SHORT_NAMES = 64;

/** The full labels an entry may name; anything longer is not a host label. */
const MAX_BASIS_LENGTH = 256;

export type FederationShortNameSource = "auto" | "override";

export interface FederationInstanceShortName {
  instanceId: string;
  shortLabel: string;
  /**
   * The full label the short name was made for. An entry applies only while
   * the instance's current label equals `basis`, so a renamed machine shows
   * its full label until the gateway names it again, never a stale nickname.
   */
  basis: string;
  source: FederationShortNameSource;
  updatedAt: number;
  /**
   * Tombstone: the instance has no short name (revoked, or an override was
   * cleared and the gateway has not named it yet). Tombstones ride the same
   * LWW merge, which is what lets a removal propagate.
   */
  removed?: boolean;
}

export function federationShortNameLength(value: string): number {
  return [...value].length;
}

/**
 * The one spelling rule for a short name, shared by the model validator and
 * the Settings rename: whitespace collapsed and trimmed, non-empty, no
 * control or format characters, at most
 * {@link FEDERATION_SHORT_NAME_MAX_LENGTH} code points. Returns undefined
 * when the value cannot be a short name.
 */
export function normalizeFederationShortName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (!collapsed) return undefined;
  if (/[\p{Cc}\p{Cf}]/u.test(collapsed)) return undefined;
  if (federationShortNameLength(collapsed) > FEDERATION_SHORT_NAME_MAX_LENGTH) {
    return undefined;
  }
  return collapsed;
}

/** Case-insensitive key for the uniqueness rule. */
export function federationShortNameKey(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

export function isFederationInstanceShortName(
  value: unknown,
): value is FederationInstanceShortName {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<FederationInstanceShortName>;
  return (
    typeof candidate.instanceId === "string"
    && candidate.instanceId.length > 0
    && typeof candidate.shortLabel === "string"
    && normalizeFederationShortName(candidate.shortLabel) === candidate.shortLabel
    && typeof candidate.basis === "string"
    && candidate.basis.length > 0
    && candidate.basis.length <= MAX_BASIS_LENGTH
    && (candidate.source === "auto" || candidate.source === "override")
    && typeof candidate.updatedAt === "number"
    && Number.isFinite(candidate.updatedAt)
    && (candidate.removed === undefined || typeof candidate.removed === "boolean")
  );
}

/**
 * The short name to draw for an instance whose current full label is
 * `label`, or undefined to draw the full label. Undefined for a missing or
 * removed entry, an entry made for a different label, and a short name that
 * is the label itself.
 */
export function federationShortLabelFor(
  entry: FederationInstanceShortName | undefined,
  label: string,
): string | undefined {
  if (!entry || entry.removed || entry.basis !== label) return undefined;
  return entry.shortLabel === label ? undefined : entry.shortLabel;
}

/**
 * Merge incoming entries into the current map, last-writer-wins. Same-instant
 * ties resolve removal first, then override before auto, then by short name,
 * so every instance converges on the same entry. Returns whether anything
 * changed, so callers can skip persistence and re-broadcast on no-op merges.
 */
export function mergeFederationInstanceShortNames(
  current: readonly FederationInstanceShortName[],
  incoming: readonly FederationInstanceShortName[],
): { entries: FederationInstanceShortName[]; changed: boolean } {
  const merged = new Map<string, FederationInstanceShortName>();
  for (const entry of current) {
    merged.set(entry.instanceId, entry);
  }
  let changed = false;
  for (const entry of incoming) {
    if (!isFederationInstanceShortName(entry)) continue;
    const existing = merged.get(entry.instanceId);
    if (existing && !shortNameEntryBeats(entry, existing)) {
      continue;
    }
    if (!existing || !sameFederationShortNameEntry(existing, entry)) {
      changed = true;
    }
    merged.set(entry.instanceId, entry);
  }
  return { entries: [...merged.values()], changed };
}

export function sameFederationShortNameEntry(
  left: FederationInstanceShortName,
  right: FederationInstanceShortName,
): boolean {
  return left.instanceId === right.instanceId
    && left.shortLabel === right.shortLabel
    && left.basis === right.basis
    && left.source === right.source
    && left.updatedAt === right.updatedAt
    && (left.removed ?? false) === (right.removed ?? false);
}

function shortNameEntryBeats(
  candidate: FederationInstanceShortName,
  incumbent: FederationInstanceShortName,
): boolean {
  if (candidate.updatedAt !== incumbent.updatedAt) {
    return candidate.updatedAt > incumbent.updatedAt;
  }
  if ((candidate.removed ?? false) !== (incumbent.removed ?? false)) {
    return candidate.removed === true;
  }
  if (candidate.source !== incumbent.source) {
    return candidate.source === "override";
  }
  if (candidate.shortLabel !== incumbent.shortLabel) {
    return candidate.shortLabel > incumbent.shortLabel;
  }
  return candidate.basis > incumbent.basis;
}

export type SetFederationShortNameRequest = {
  /** Any instance of the machine; every instance sharing its label is renamed. */
  instanceId: string;
  /** A name applies an operator override; null hands the machine back to the gateway. */
  shortLabel: string | null;
};

export type SetFederationShortNameResponse = {
  entries: FederationInstanceShortName[];
};
