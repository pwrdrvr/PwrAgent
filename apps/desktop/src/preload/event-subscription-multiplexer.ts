export type EventSubscription<T> = (
  callback: (event: T) => void,
) => () => void;

/**
 * Share one source subscription across independent renderer consumers.
 * The source is attached lazily and released after the final consumer leaves.
 */
export function createEventSubscriptionMultiplexer<T>(
  subscribeToSource: (callback: (event: T) => void) => () => void,
): EventSubscription<T> {
  const consumers = new Set<{ callback: (event: T) => void }>();
  let unsubscribeFromSource: (() => void) | undefined;

  const fanOut = (event: T): void => {
    for (const consumer of [...consumers]) {
      consumer.callback(event);
    }
  };

  return (callback) => {
    const consumer = { callback };
    consumers.add(consumer);

    if (consumers.size === 1) {
      try {
        unsubscribeFromSource = subscribeToSource(fanOut);
      } catch (error) {
        consumers.delete(consumer);
        throw error;
      }
    }

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      consumers.delete(consumer);

      if (consumers.size === 0) {
        const unsubscribe = unsubscribeFromSource;
        unsubscribeFromSource = undefined;
        unsubscribe?.();
      }
    };
  };
}
