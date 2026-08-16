/**
 * Compact a burst of otherwise-lossless tool activities for a summary surface.
 *
 * Callers retain and render `items` when the operator expands the surrounding
 * transcript section. This helper only determines the compact label and count
 * shown before that expansion, so it deliberately never drops an item.
 */
export type ToolActivityBurstItem = {
  label: string;
  status?: string;
};

export type ToolActivityBurstGroup<T extends ToolActivityBurstItem> = {
  count: number;
  items: T[];
  label: string;
};

const UNINFORMATIVE_TOOL_ACTIVITY_LABELS = new Set([
  "command",
  "ran command",
  "tool",
  "unknown",
  "used tool",
]);

export const TOOL_DETAILS_UNAVAILABLE_LABEL = "Tool details unavailable";

export function normalizeToolActivityBurstLabel(label: string | undefined): string {
  const normalized = label?.replace(/\s+/g, " ").trim() ?? "";
  return !normalized
    || UNINFORMATIVE_TOOL_ACTIVITY_LABELS.has(normalized.toLowerCase())
    ? TOOL_DETAILS_UNAVAILABLE_LABEL
    : normalized;
}

export function coalesceToolActivityBurst<T extends ToolActivityBurstItem>(
  items: readonly T[],
): ToolActivityBurstGroup<T>[] {
  const groups = new Map<string, ToolActivityBurstGroup<T>>();
  for (const item of items) {
    const label = normalizeToolActivityBurstLabel(item.label);
    // A failed retry is semantically distinct from a successful invocation of
    // the same tool. Keeping statuses separate prevents a concise summary from
    // disguising failures or cancellation.
    const key = `${item.status ?? ""}\0${label}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.items.push(item);
      continue;
    }
    groups.set(key, { count: 1, items: [item], label });
  }
  return [...groups.values()];
}
