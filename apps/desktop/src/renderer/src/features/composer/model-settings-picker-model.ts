import { CODEX_SPEED_LABELS, type CodexSpeed } from "@pwragent/shared/codex-speed";

/**
 * A catalog's `default` entry (Claude lists it before its levels) means "the
 * model's own default". It is not a level, so the effort bar draws it as a
 * separate chip before the stops instead of as the bar's lowest step.
 */
export const MODEL_DEFAULT_EFFORT = "default";

// Fast keeps the old Fast toggle's tooltip copy. Ultrafast claims only what
// the catalog proves: the model advertises it, and nothing is priced yet.
export const CODEX_SPEED_DESCRIPTIONS: Record<CodexSpeed, string> = {
  standard: "Default processing",
  fast: "Faster, lower-latency responses",
  ultrafast: "The fastest tier this model offers",
};

/** The effort levels providers name, least to most. */
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Split a catalog's effort list into the bar's stops and its default entry.
 * The bar always rises left to right, so known levels are put in that order:
 * Grok lists its levels most-first. A list with a level this table does not
 * know keeps the catalog's order, which is the only order it has.
 */
export function splitEffortChoices(efforts: readonly string[]): {
  stops: string[];
  hasModelDefault: boolean;
} {
  const listed = efforts.filter((effort) => effort !== MODEL_DEFAULT_EFFORT);
  const stops = listed.every((effort) => EFFORT_LEVELS.includes(effort))
    ? [...listed].sort((left, right) => EFFORT_LEVELS.indexOf(left) - EFFORT_LEVELS.indexOf(right))
    : listed;
  return { stops, hasModelDefault: listed.length !== efforts.length };
}

/**
 * The stop a pointer at `x` selects on a track that starts at `left` and is
 * `width` wide, split into `count` equal segments. Positions outside the
 * track clamp to its ends, so a drag past either end holds the end stop.
 */
export function effortStopAtPointer(x: number, left: number, width: number, count: number): number {
  if (count <= 0) return -1;
  if (!(width > 0)) return 0;
  const raw = Math.floor(((x - left) / width) * count);
  return Math.max(0, Math.min(count - 1, raw));
}

/**
 * The stop a key moves the effort slider to, or undefined when the key is
 * not a slider key. From no stop (the model default is chosen), a forward
 * key or Home lands on the first stop and End on the last; a backward key
 * does nothing, because the default is its own control.
 */
export function effortStopForKey(key: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  const last = count - 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return index < 0 ? 0 : Math.min(last, index + 1);
    case "ArrowLeft":
    case "ArrowDown":
      return index < 0 ? undefined : Math.max(0, index - 1);
    case "PageUp":
      return index < 0 ? 0 : Math.min(last, index + 2);
    case "PageDown":
      return index < 0 ? undefined : Math.max(0, index - 2);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return undefined;
  }
}

/**
 * `effortStopForKey` on a bar whose disabled stops are drawn but never
 * chosen. A key that lands on a disabled stop carries on past it the way the
 * key moves (Home forward from the first stop, End back from the last). When
 * nothing usable lies that way, it settles on the farthest usable stop
 * between the current one and where the key landed, else does nothing.
 */
export function steppedStopForKey(
  key: string,
  index: number,
  enabled: readonly boolean[],
): number | undefined {
  const count = enabled.length;
  const target = effortStopForKey(key, index, count);
  if (target === undefined || enabled[target]) return target;
  const step = key === "Home" ? 1 : key === "End" ? -1 : target >= index ? 1 : -1;
  for (let stop = target + step; stop >= 0 && stop < count; stop += step) {
    if (enabled[stop]) return stop;
  }
  for (let stop = target - step; stop !== index && stop >= 0 && stop < count; stop -= step) {
    if (enabled[stop]) return stop;
  }
  return undefined;
}

/**
 * Which stops get a label under the bar. Every stop while they fit (six at
 * the panel's width); past that only the ends and the chosen stop.
 */
export function effortStopLabelled(stop: number, count: number, chosen: number): boolean {
  if (count <= 6) return true;
  return stop === 0 || stop === count - 1 || stop === chosen;
}

/** The pill meter's tick heights in px, rising with the stop index. */
export function effortMeterHeights(count: number): number[] {
  return Array.from({ length: count }, (_, index) => 4 + Math.round((7 * (index + 1)) / count));
}

/**
 * The pill's accessible name and tooltip: "Model settings: Claude, Opus 5.5,
 * high effort, Fast". The provider is named only where the pill shows it.
 */
export function modelSettingsSummary(params: {
  label: string;
  provider?: string;
  model: string;
  effort?: string;
  speed?: CodexSpeed;
}): string {
  const parts = [
    params.provider,
    params.model,
    params.effort ? `${params.effort} effort` : undefined,
    params.speed && params.speed !== "standard" ? CODEX_SPEED_LABELS[params.speed] : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `${params.label}: ${parts.join(", ")}` : params.label;
}

export type ModelSettingsPanelPlacement = {
  left: number;
  top: number;
  maxHeight: number;
};

/**
 * The left edge, from the trigger's, of the panel opened above the composer.
 * It holds where it opened (`anchor`, the trigger's left then) while the
 * chips before the trigger change width under it, and moves only as far as
 * it takes to stay `padding` inside the window.
 */
export function heldPanelOffset(params: {
  anchor: number;
  triggerLeft: number;
  width: number;
  viewportWidth: number;
  padding?: number;
}): number {
  const padding = params.padding ?? 8;
  const left = Math.max(
    Math.min(params.anchor, padding),
    Math.min(params.anchor, params.viewportWidth - padding - params.width),
  );
  return left - params.triggerLeft;
}

/**
 * The bottom edge of the panel opened above the composer, in window
 * coordinates. It sits a `gap` over the toolbar's top row (`shelfTop`), so it
 * never covers the chips, and holds where it opened (`held`) while picks
 * rearrange the toolbar. It rises only when the toolbar grows up into it,
 * and never drops back.
 */
export function heldPanelFoot(params: { held?: number; shelfTop: number; gap?: number }): number {
  const clear = params.shelfTop - (params.gap ?? 8);
  return params.held === undefined ? clear : Math.min(params.held, clear);
}

/**
 * Where a portalled panel goes: under the trigger when it prefers below and
 * fits (or has more room there), otherwise above. It stays `padding` inside
 * the window on every side, and `maxHeight` is the room on the chosen side,
 * so a tall panel scrolls instead of leaving the window.
 */
export function placeModelSettingsPanel(params: {
  trigger: { left: number; top: number; bottom: number };
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  prefer: "above" | "below";
  gap?: number;
  padding?: number;
}): ModelSettingsPanelPlacement {
  const gap = params.gap ?? 8;
  const padding = params.padding ?? 8;
  const below = Math.max(0, params.viewportHeight - params.trigger.bottom - gap - padding);
  const above = Math.max(0, params.trigger.top - gap - padding);
  const preferred = params.prefer === "below" ? below : above;
  const other = params.prefer === "below" ? above : below;
  const usePreferred = preferred >= params.height || preferred >= other;
  const side = usePreferred ? params.prefer : params.prefer === "below" ? "above" : "below";
  const room = side === "below" ? below : above;
  const shown = Math.min(params.height, room);
  const top = side === "below"
    ? params.trigger.bottom + gap
    : params.trigger.top - gap - shown;
  const maxLeft = params.viewportWidth - params.width - padding;
  const left = Math.max(padding, Math.min(params.trigger.left, maxLeft));
  return { left, top: Math.max(padding, top), maxHeight: room };
}
