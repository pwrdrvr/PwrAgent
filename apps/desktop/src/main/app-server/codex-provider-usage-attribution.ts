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
            ? pending.then((line) => single.call(target, { ...params, line }))
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
          return Promise.all(pending.map((entry, index) => entry ?? params.lines[index]))
            .then((lines) => batch.call(target, { ...params, lines }));
        };
      }
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
}
