export function normalizeDetachedPrKeys(keys: string[] | undefined): string[] {
  return [
    ...new Set(
      (keys ?? [])
        .map((key) => key.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

/**
 * Detached PR status keys under the forge's current repository names.
 *
 * A renamed repository showed one PR as two chips, one per name, and
 * detaching either chip removed a duplicate, not the PR. So a detached key is
 * released while the thread still holds a row for the same PR under another
 * stored key: that is the copy the operator kept, or one attached again under
 * the new name. Every other key moves to the new name, which keeps a PR
 * detached once the forge reports it under that name.
 */
export function canonicalizeDetachedPrKeys(params: {
  detachedPrKeys: string[] | undefined;
  attachedPrKeys: Iterable<string>;
  canonicalizePrKey: (key: string) => string;
}): { detachedPrKeys: string[]; releasedPrKeys: Set<string> } {
  const attachedByCanonical = new Map<string, Set<string>>();
  for (const key of normalizeDetachedPrKeys([...params.attachedPrKeys])) {
    const canonical = params.canonicalizePrKey(key);
    attachedByCanonical.set(canonical, (attachedByCanonical.get(canonical) ?? new Set()).add(key));
  }
  const releasedPrKeys = new Set<string>();
  const detachedPrKeys = normalizeDetachedPrKeys(
    normalizeDetachedPrKeys(params.detachedPrKeys).flatMap((key) => {
      const canonical = params.canonicalizePrKey(key);
      const attached = attachedByCanonical.get(canonical);
      if (attached && [...attached].some((attachedKey) => attachedKey !== key)) {
        releasedPrKeys.add(key);
        return [];
      }
      return [canonical];
    }),
  );
  return { detachedPrKeys, releasedPrKeys };
}

