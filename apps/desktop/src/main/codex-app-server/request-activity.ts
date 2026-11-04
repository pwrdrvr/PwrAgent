import { AsyncLocalStorage } from "node:async_hooks";

const requestActivity = new AsyncLocalStorage<{ countsAsActivity: boolean }>();

/**
 * Classify a caller's RPCs, including pagination and retries, without changing
 * the wire protocol. Async scope keeps a poll from suppressing concurrent
 * operator requests. Ordinary callers count as activity by default.
 */
export function withCodexRequestActivity<T>(
  options: { countsAsActivity: boolean },
  work: () => T,
): T {
  return requestActivity.run(options, work);
}

export function codexRequestCountsAsActivity(): boolean {
  return requestActivity.getStore()?.countsAsActivity ?? true;
}
