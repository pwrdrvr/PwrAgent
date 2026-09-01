/**
 * Insertion-ordered maps with a ceiling, for bookkeeping that must not grow
 * without bound.
 *
 * A `Map` iterates in insertion order, so its first key is its oldest entry.
 * That makes oldest-first eviction a two-line loop -- which is exactly why it
 * kept getting written again by hand, each copy another place to get the
 * `.keys().next()` / `.done` dance subtly wrong.
 */

/**
 * Store `value` under `key`, then evict oldest-first until the map fits.
 *
 * Re-setting an existing key does NOT refresh its position: `Map.set` keeps the
 * original insertion order. This is a size ceiling, not an LRU -- reach for
 * something else if recency of *use* is what should decide eviction.
 */
export function rememberBoundedMap<Value>(
  map: Map<string, Value>,
  key: string,
  value: Value,
  maxSize: number,
): void {
  map.set(key, value);
  while (map.size > maxSize) {
    const oldest = map.keys().next();
    if (oldest.done) {
      break;
    }
    map.delete(oldest.value);
  }
}
