import type { ReadUsageActivityResponse, UsageLimitObservation } from "@pwragent/shared/contracts/usage-activity";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The widest window one owner read may ask for. Every owner, including peers
 * on older builds, rejects a window over 31 days, so a longer period is read
 * in pieces of at most this span.
 */
export const USAGE_READ_MAX_SPAN = 30 * DAY;
/** Reads one owner may spend on a period before it keeps a truncated piece. */
export const USAGE_READ_MAX_PIECES = 64;

export type UsageWindow = { from: number; to: number };

/**
 * Splits `[from, to)` into adjacent pieces of at most `maxSpan`, newest
 * first. Inner boundaries sit on whole hours: an owner rolls helpers up in
 * steps that divide an hour and only rolls up helpers inside the window, so
 * an hour-aligned cut never splits a rollup bucket.
 */
export function usageReadPieces(from: number, to: number, maxSpan = USAGE_READ_MAX_SPAN): UsageWindow[] {
  if (!(to > from)) return [];
  const pieces: UsageWindow[] = [];
  let end = to;
  while (end - from > maxSpan) {
    // Round up so the piece never exceeds `maxSpan`.
    const cut = Math.ceil((end - maxSpan) / HOUR) * HOUR;
    // A span under an hour past `from` cannot be aligned inside it.
    const start = cut > from && cut < end ? cut : end - maxSpan;
    pieces.push({ from: start, to: end });
    end = start;
  }
  pieces.push({ from, to: end });
  return pieces;
}

/** Halves a piece on an hour boundary, newest half first; undefined when it cannot be split. */
export function splitUsageReadPiece(piece: UsageWindow): [UsageWindow, UsageWindow] | undefined {
  const mid = Math.round((piece.from + (piece.to - piece.from) / 2) / HOUR) * HOUR;
  if (mid <= piece.from || mid >= piece.to) return undefined;
  return [{ from: mid, to: piece.to }, { from: piece.from, to: mid }];
}

const historyKey = (reading: UsageLimitObservation) => JSON.stringify(reading);

/**
 * Merges one owner's piece responses, newest piece first. Rows and window
 * readings combine; the owner's current state (limits, rate limits, analysis
 * backends, account token history) comes from the newest piece, the read
 * nearest to now. Duplicate rows across pieces are left for the viewer's
 * identity deduplication, which already prefers the authoritative copy.
 */
export function mergeUsageActivityPieces(pieces: readonly ReadUsageActivityResponse[]): ReadUsageActivityResponse {
  const [newest] = pieces;
  if (!newest) throw new Error("No usage activity was read.");
  if (pieces.length === 1) return newest;
  const readings = (select: (piece: ReadUsageActivityResponse) => UsageLimitObservation[] | undefined) => {
    if (pieces.every((piece) => select(piece) === undefined)) return undefined;
    const seen = new Map<string, UsageLimitObservation>();
    for (const piece of pieces) for (const reading of select(piece) ?? []) seen.set(historyKey(reading), reading);
    return [...seen.values()].sort((a, b) => a.observedAt - b.observedAt);
  };
  const limitHistory = readings((piece) => piece.limitHistory);
  const providerLimitHistory = readings((piece) => piece.providerLimitHistory);
  return {
    ...newest,
    rows: pieces.flatMap((piece) => piece.rows),
    truncated: pieces.some((piece) => piece.truncated),
    ...limitHistory ? { limitHistory } : {},
    ...providerLimitHistory ? { providerLimitHistory } : {},
  };
}

/**
 * Reads one owner's `[from, to)` in pieces no owner rejects, splitting any
 * piece that came back truncated (an owner returns at most its newest 5,000
 * rows) until it fits or can no longer be split, within `maxPieces` reads.
 * Account-wide token history is period-independent, so only the first,
 * newest read asks for it.
 */
export async function readUsageActivityInPieces(
  read: (window: UsageWindow, includeAccountTokenUsage: boolean) => Promise<ReadUsageActivityResponse>,
  window: UsageWindow,
  options: { includeAccountTokenUsage?: boolean; maxSpan?: number; maxPieces?: number } = {},
): Promise<ReadUsageActivityResponse> {
  const maxPieces = options.maxPieces ?? USAGE_READ_MAX_PIECES;
  const pending = usageReadPieces(window.from, window.to, options.maxSpan);
  const done: ReadUsageActivityResponse[] = [];
  let reads = 0;
  while (pending.length) {
    const piece = pending.shift()!;
    const response = await read(piece, reads === 0 && options.includeAccountTokenUsage === true);
    reads += 1;
    const halves = response.truncated && reads + pending.length + 2 <= maxPieces ? splitUsageReadPiece(piece) : undefined;
    if (halves) {
      // Reread both halves in place; keep the owner's current state from this first answer.
      pending.unshift(...halves);
      if (done.length === 0) done.push({ ...response, rows: [], truncated: false, limitHistory: undefined, providerLimitHistory: undefined });
      continue;
    }
    done.push(response);
  }
  return mergeUsageActivityPieces(done);
}
