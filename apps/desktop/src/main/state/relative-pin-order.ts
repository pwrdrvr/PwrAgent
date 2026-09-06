import type { NavigationRelativePinMove } from "@pwragent/shared";

/** Resolve an action against owner metadata inside the caller's write transaction. */
export function moveRelativePin(
  pins: readonly { key: string; rank: string }[],
  move: NavigationRelativePinMove,
): string[] {
  const keys = [...pins].sort((left, right) => Number(left.rank) - Number(right.rank)
    || left.key.localeCompare(right.key)).map((pin) => pin.key);
  const index = keys.indexOf(move.key);
  if (index < 0) throw new Error("The pin no longer exists. Refresh navigation and try again.");
  if (move.direction !== undefined) {
    if (move.direction !== "up" && move.direction !== "down") throw new Error("Invalid pin move direction.");
    const destination = index + (move.direction === "up" ? -1 : 1);
    if (destination < 0 || destination >= keys.length) return keys;
    [keys[index], keys[destination]] = [keys[destination]!, keys[index]!];
    return keys;
  }
  if (move.placement !== "before" && move.placement !== "after") throw new Error("Invalid relative pin placement.");
  if (!keys.includes(move.anchorKey)) throw new Error("The destination pin no longer exists. Refresh navigation and try again.");
  if (move.key === move.anchorKey) return keys;
  keys.splice(index, 1);
  const destination = keys.indexOf(move.anchorKey) + (move.placement === "after" ? 1 : 0);
  keys.splice(destination, 0, move.key);
  return keys;
}

/** Usually one rank write; compact only when adjacent floating-point ranks have no gap. */
export function relativePinRanks(
  pins: readonly { key: string; rank: string }[],
  move: NavigationRelativePinMove,
): Record<string, string> {
  const ordered = moveRelativePin(pins, move);
  const ranks = new Map(pins.map((pin) => [pin.key, Number(pin.rank)]));
  const index = ordered.indexOf(move.key);
  const previous = index > 0 ? ranks.get(ordered[index - 1]!) : undefined;
  const next = index + 1 < ordered.length ? ranks.get(ordered[index + 1]!) : undefined;
  const current = ranks.get(move.key)!;
  if (Number.isFinite(current) && (previous === undefined || current > previous)
    && (next === undefined || current < next)) return {};
  const candidate = previous === undefined ? (next ?? 2048) - 1024
    : next === undefined ? previous + 1024 : previous + (next - previous) / 2;
  if (Number.isFinite(candidate) && (previous === undefined || candidate > previous)
    && (next === undefined || candidate < next)) return { [move.key]: String(candidate) };
  return Object.fromEntries(ordered.map((key, position) => [key, String((position + 1) * 1024)]));
}
