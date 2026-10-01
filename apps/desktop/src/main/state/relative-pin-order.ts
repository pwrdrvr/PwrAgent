import {
  buildTierPinRanks,
  comparePinRanks,
  isKeptAtTopRank,
  type NavigationRelativePinMove,
} from "@pwragent/shared";

type RankedPin = { key: string; rank: string };

/**
 * Resolve an action against owner metadata inside the caller's write
 * transaction. Returns the destination tier's order with the moved pin in
 * place; the other tier is untouched by every move.
 */
export function moveRelativePin(
  pins: readonly RankedPin[],
  move: NavigationRelativePinMove,
): { keptAtTop: boolean; keys: string[] } {
  const sorted = [...pins].sort((left, right) => comparePinRanks(left.rank, right.rank)
    || left.key.localeCompare(right.key));
  const source = sorted.find((pin) => pin.key === move.key);
  if (!source) throw new Error("The pin no longer exists. Refresh navigation and try again.");
  const tierKeys = (keptAtTop: boolean): string[] => sorted
    .filter((pin) => isKeptAtTopRank(pin.rank) === keptAtTop)
    .map((pin) => pin.key);
  const sourceKeptAtTop = isKeptAtTopRank(source.rank);
  if (move.keepAtTop !== undefined) {
    if (typeof move.keepAtTop !== "boolean") throw new Error("Invalid keep-at-top pin move.");
    const keys = tierKeys(move.keepAtTop).filter((key) => key !== move.key);
    if (move.keepAtTop) keys.push(move.key);
    else keys.unshift(move.key);
    return { keptAtTop: move.keepAtTop, keys };
  }
  if (move.direction !== undefined) {
    if (move.direction !== "up" && move.direction !== "down") throw new Error("Invalid pin move direction.");
    const keys = tierKeys(sourceKeptAtTop);
    const index = keys.indexOf(move.key);
    const destination = index + (move.direction === "up" ? -1 : 1);
    if (destination < 0 || destination >= keys.length) return { keptAtTop: sourceKeptAtTop, keys };
    [keys[index], keys[destination]] = [keys[destination]!, keys[index]!];
    return { keptAtTop: sourceKeptAtTop, keys };
  }
  if (move.placement !== "before" && move.placement !== "after") throw new Error("Invalid relative pin placement.");
  const anchor = sorted.find((pin) => pin.key === move.anchorKey);
  if (!anchor) throw new Error("The destination pin no longer exists. Refresh navigation and try again.");
  const keptAtTop = isKeptAtTopRank(anchor.rank);
  if (move.key === move.anchorKey) return { keptAtTop, keys: tierKeys(keptAtTop) };
  const keys = tierKeys(keptAtTop).filter((key) => key !== move.key);
  const destination = keys.indexOf(move.anchorKey) + (move.placement === "after" ? 1 : 0);
  keys.splice(destination, 0, move.key);
  return { keptAtTop, keys };
}

/**
 * Usually one rank write; compact only when adjacent floating-point ranks
 * have no gap. Both happen inside the destination tier, so a rank never lands
 * between the two tiers' bands.
 */
export function relativePinRanks(
  pins: readonly RankedPin[],
  move: NavigationRelativePinMove,
): Record<string, string> {
  const { keptAtTop, keys: ordered } = moveRelativePin(pins, move);
  const ranks = new Map(pins.map((pin) => [pin.key, Number(pin.rank)]));
  const index = ordered.indexOf(move.key);
  const previous = index > 0 ? ranks.get(ordered[index - 1]!) : undefined;
  const next = index + 1 < ordered.length ? ranks.get(ordered[index + 1]!) : undefined;
  const current = ranks.get(move.key)!;
  if (isKeptAtTopRank(String(current)) === keptAtTop && Number.isFinite(current)
    && (previous === undefined || current > previous)
    && (next === undefined || current < next)) return {};
  const candidate = previous === undefined && next === undefined
    ? Number(buildTierPinRanks([move.key], keptAtTop)[move.key])
    : previous === undefined ? next! - 1024
    : next === undefined ? previous + 1024 : previous + (next - previous) / 2;
  if (Number.isFinite(candidate) && isKeptAtTopRank(String(candidate)) === keptAtTop
    && (previous === undefined || candidate > previous)
    && (next === undefined || candidate < next)) return { [move.key]: String(candidate) };
  return buildTierPinRanks(ordered, keptAtTop);
}
