import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";

/**
 * Local main, and owners that advertise `thread_display_bulk_reads`, serve a
 * whole display refresh in one read. Every read rebuilds the thread's display
 * on the owner, so other owners keep the legacy 256-turn and 20-row requests.
 */
export function supportsBulkDisplayReads(
  target: FederationTarget | undefined,
  thread: Pick<NavigationThreadSummary, "federation"> | undefined,
): boolean {
  return target?.scope !== "remote"
    || Boolean(thread?.federation?.capabilities?.includes("thread_display_bulk_reads"));
}
