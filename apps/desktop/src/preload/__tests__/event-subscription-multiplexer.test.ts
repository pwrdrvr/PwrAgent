import { describe, expect, it, vi } from "vitest";
import { createEventSubscriptionMultiplexer } from "../event-subscription-multiplexer";

describe("createEventSubscriptionMultiplexer", () => {
  it("shares one source listener across more than ten consumers and releases it last", () => {
    let sourceListener: ((event: string) => void) | undefined;
    const unsubscribeFromSource = vi.fn(() => {
      sourceListener = undefined;
    });
    const subscribeToSource = vi.fn((listener: (event: string) => void) => {
      sourceListener = listener;
      return unsubscribeFromSource;
    });
    const subscribe = createEventSubscriptionMultiplexer(subscribeToSource);
    const consumers = Array.from({ length: 11 }, () => vi.fn());
    const unsubscribers = consumers.map((consumer) => subscribe(consumer));

    expect(subscribeToSource).toHaveBeenCalledTimes(1);

    sourceListener?.("thread/updated");
    for (const consumer of consumers) {
      expect(consumer).toHaveBeenCalledWith("thread/updated");
    }

    for (const unsubscribe of unsubscribers.slice(0, -1)) {
      unsubscribe();
    }
    expect(unsubscribeFromSource).not.toHaveBeenCalled();

    unsubscribers.at(-1)?.();
    expect(unsubscribeFromSource).toHaveBeenCalledTimes(1);
  });

  it("supports duplicate callbacks and idempotent cleanup", () => {
    const sourceListeners = new Set<(event: string) => void>();
    const subscribe = createEventSubscriptionMultiplexer<string>((listener) => {
      sourceListeners.add(listener);
      return () => {
        sourceListeners.delete(listener);
      };
    });
    const consumer = vi.fn();
    const unsubscribeFirst = subscribe(consumer);
    const unsubscribeSecond = subscribe(consumer);

    for (const listener of sourceListeners) {
      listener("first");
    }
    expect(consumer).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    unsubscribeFirst();
    for (const listener of sourceListeners) {
      listener("second");
    }
    expect(consumer).toHaveBeenCalledTimes(3);
    expect(sourceListeners.size).toBe(1);

    unsubscribeSecond();
    expect(sourceListeners.size).toBe(0);
  });

  it("restores a lazy source subscription after every consumer unmounts", () => {
    const unsubscribeFromSource = vi.fn();
    const subscribeToSource = vi.fn(() => unsubscribeFromSource);
    const subscribe =
      createEventSubscriptionMultiplexer<string>(subscribeToSource);

    const unsubscribeFirst = subscribe(vi.fn());
    unsubscribeFirst();
    const unsubscribeSecond = subscribe(vi.fn());

    expect(subscribeToSource).toHaveBeenCalledTimes(2);
    expect(unsubscribeFromSource).toHaveBeenCalledTimes(1);

    unsubscribeSecond();
    expect(unsubscribeFromSource).toHaveBeenCalledTimes(2);
  });
});
