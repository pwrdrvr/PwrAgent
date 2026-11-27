import type { ProviderAccessModeOption } from "./provider-access-mode";

/**
 * How much an access option lets the agent do, least to most: Plan (reads
 * and proposes only) < Default < Accept Edits < Auto < Full Access.
 */
export type ProviderAccessTier = "plan" | "default" | "edits" | "auto" | "full";

/** Each tier's rank. A higher rank lets the agent do more. */
export const PROVIDER_ACCESS_TIER_RANK: Readonly<Record<ProviderAccessTier, number>> = {
  plan: 0,
  default: 1,
  edits: 2,
  auto: 3,
  full: 4,
};

/**
 * The tier of an agent's own mode id, keyed by the id with case, `-`, `_`
 * and spaces removed. Antigravity's hybrid list mixes these native ids with
 * PwrAgent's execution modes, so its order is defined here rather than by
 * the order the agent lists them in. Yolo is the only native mode that skips
 * every permission request (`acpRuntimeModeIsFullAccess`).
 */
const NATIVE_MODE_TIERS: Readonly<Record<string, ProviderAccessTier>> = {
  plan: "plan",
  default: "default",
  acceptedits: "edits",
  autoedit: "edits",
  autoedits: "edits",
  auto: "auto",
  yolo: "full",
  fullaccess: "full",
};

function nativeModeKey(id: string): string {
  return id.trim().toLowerCase().replace(/[-_\s]+/g, "");
}

/**
 * The tier of one access option, or undefined for an agent's mode this table
 * does not know. An option that runs under Full Access is always `full`.
 */
export function providerAccessOptionTier(
  option: Pick<ProviderAccessModeOption, "kind" | "value" | "executionMode">,
): ProviderAccessTier | undefined {
  if (option.executionMode === "full-access") {
    return "full";
  }
  if (option.kind === "execution") {
    return option.executionMode === "auto" ? "auto" : "default";
  }
  return NATIVE_MODE_TIERS[nativeModeKey(option.value)];
}

/**
 * The option's rank. An unknown agent mode runs under PwrAgent's Default
 * envelope, so it ranks with Default.
 */
export function providerAccessOptionRank(
  option: Pick<ProviderAccessModeOption, "kind" | "value" | "executionMode">,
): number {
  return PROVIDER_ACCESS_TIER_RANK[providerAccessOptionTier(option) ?? "default"];
}

/**
 * The options as stops on a level bar, least freedom first. The sort is
 * stable, so options of equal rank keep the provider's order.
 */
export function orderProviderAccessOptions<T extends ProviderAccessModeOption>(
  options: readonly T[],
): T[] {
  return options
    .map((option, index) => ({ option, index, rank: providerAccessOptionRank(option) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.option);
}
