import type { AppServerThreadActivityDetail } from "@pwragent/shared";

type DetailIndex = {
  ids: Set<string>;
  labels: Set<string>;
  commands: Set<string>;
  diffs: Set<string>;
};

// Renderer detail arrays are immutable. Reuse the hydrated side of the join
// across output chunks; replacing a replay array naturally builds a new index.
// Weak keys keep evicted thread history from being retained by this cache.
const indexes = new WeakMap<readonly AppServerThreadActivityDetail[], DetailIndex>();

function indexDetails(details: readonly AppServerThreadActivityDetail[]): DetailIndex {
  const cached = indexes.get(details);
  if (cached) {
    return cached;
  }
  const index: DetailIndex = {
    ids: new Set(), labels: new Set(), commands: new Set(), diffs: new Set(),
  };
  for (const detail of details) {
    index.ids.add(detail.id);
    index.labels.add(detail.label);
    if (detail.command?.displayCommand) {
      index.commands.add(detail.command.displayCommand);
    }
    if (detail.fileDiff?.diff) {
      index.diffs.add(detail.fileDiff.diff);
    }
  }
  indexes.set(details, index);
  return index;
}

/** Match replay details against live details without considering output text. */
export function activityDetailsMatch(
  candidate: readonly AppServerThreadActivityDetail[],
  optimistic: readonly AppServerThreadActivityDetail[],
  matchLabels: boolean,
): boolean {
  const index = indexDetails(candidate);
  return optimistic.every((detail) => {
    if (index.ids.has(detail.id) || (matchLabels && index.labels.has(detail.label))) {
      return true;
    }
    // Preserve the original preference: a command detail cannot fall back to
    // its file diff when the command itself does not match.
    if (detail.command?.displayCommand) {
      return index.commands.has(detail.command.displayCommand);
    }
    return Boolean(detail.fileDiff?.diff && index.diffs.has(detail.fileDiff.diff));
  });
}
