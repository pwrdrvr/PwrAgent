import type { ThreadUsageLineRecord } from "@pwragent/shared";

/**
 * Decide whether a usage line belongs to a Codex model provider. Returns
 * undefined, synchronously, for every line that stays as written, so ordinary
 * OpenAI usage keeps its write timing exactly.
 */
export type CodexProviderUsageAttributor = (
  line: ThreadUsageLineRecord,
) => Promise<ThreadUsageLineRecord> | undefined;

/**
 * Route every usage-line write through provider attribution.
 *
 * The registry writes usage lines from about thirty places, each building the
 * line its own way. All of them end at these two store methods, so this is
 * the one place a provider thread's lines can be re-attributed before they
 * are persisted. Every other store member passes through untouched.
 */
export function wrapCodexProviderUsageAttribution<T extends object>(
  store: T,
  attribute: CodexProviderUsageAttributor,
): T {
  // Attributed writes wait on an async read, so they are issued in arrival
  // order through one chain. Two upserts of the same line (a live update,
  // then the turn's completion) must reach the store in the order sent.
  let attributedWrites: Promise<unknown> = Promise.resolve();
  const inOrder = <R>(write: () => Promise<R>): Promise<R> => {
    const next = attributedWrites.catch(() => undefined).then(write);
    attributedWrites = next;
    return next;
  };
  return new Proxy(store, {
    get(target, property, receiver) {
      // Read the method at each access, so a later replacement on the store
      // (a test spy, a reopened database) is the one that writes.
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "upsertThreadUsageLine") {
        const single = value as (params: { line: ThreadUsageLineRecord }) => Promise<unknown>;
        return (params: { line: ThreadUsageLineRecord }) => {
          const pending = attribute(params.line);
          return pending
            ? inOrder(async () => await single.call(target, { ...params, line: await pending }))
            : single.call(target, params);
        };
      }
      if (property === "upsertThreadUsageLines") {
        const batch = value as (params: { lines: ThreadUsageLineRecord[] }) => Promise<unknown>;
        return (params: { lines: ThreadUsageLineRecord[] }) => {
          const pending = params.lines.map((line) => attribute(line));
          if (pending.every((entry) => entry === undefined)) {
            return batch.call(target, params);
          }
          return inOrder(async () => await batch.call(target, {
            ...params,
            lines: await Promise.all(pending.map((entry, index) => entry ?? params.lines[index])),
          }));
        };
      }
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
}
