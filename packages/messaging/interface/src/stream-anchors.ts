/**
 * Bounded eviction for the per-stream anchor maps every provider adapter keeps
 * (keyed by `intent.stream.key`). Those maps are cleared when a stream's final
 * chunk lands, but a turn that is interrupted/cancelled never sends a final
 * update, so its entry — including the full text of each posted chunk — would
 * otherwise linger for the adapter's whole lifetime. Calling this after each
 * `set` caps the map at `maxEntries`, evicting the oldest (insertion-order)
 * entries first, so an abandoned turn's leak is reclaimed once newer turns
 * arrive. `maxEntries` is far above any realistic count of concurrent live
 * streams, so it never evicts an in-flight stream.
 */
export function evictStaleStreamAnchors(
  map: Map<string, unknown>,
  maxEntries = 256,
): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}
