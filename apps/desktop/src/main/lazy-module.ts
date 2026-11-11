/**
 * A module loaded on first use. `load()` imports it once and caches the
 * result; a failed load is not cached, so the next call retries.
 */
export type LazyModule<T> = {
  load(): Promise<T>;
  /** The module when a `load()` has finished, else undefined. */
  loaded(): T | undefined;
};

export function lazyModule<T>(importModule: () => Promise<T>): LazyModule<T> {
  let value: T | undefined;
  let loading: Promise<T> | undefined;
  return {
    load: () => loading ??= importModule().then(
      (module) => value = module,
      (error: unknown) => {
        // A failed load is not cached, so the next call retries.
        loading = undefined;
        throw error;
      },
    ),
    loaded: () => value,
  };
}
