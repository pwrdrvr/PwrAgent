import { ARCHIVE_CLEANUP_SLICE_SIZE, type ArchiveCleanupContext } from "./archive-cleanup-queue";

export const MAINTENANCE_AUDIT_CONCURRENCY = 6;

/** Independent read-only checks, with stable output order and one pacing
 * boundary per slice. Drain started reads before returning any failure. */
export async function mapMaintenanceAudit<T, R>(
  items: readonly T[],
  context: Pick<ArchiveCleanupContext, "checkpoint" | "assertCurrent">,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  for (let offset = 0; offset < items.length; offset += ARCHIVE_CLEANUP_SLICE_SIZE) {
    await context.checkpoint();
    const end = Math.min(items.length, offset + ARCHIVE_CLEANUP_SLICE_SIZE);
    let next = offset;
    let failure: { error: unknown } | undefined;
    await Promise.all(Array.from({ length: Math.min(MAINTENANCE_AUDIT_CONCURRENCY, end - offset) }, async () => {
      while (next < end && !failure) {
        const index = next++;
        try {
          context.assertCurrent();
          results[index] = await work(items[index]!);
        } catch (error) { failure ??= { error }; }
      }
    }));
    if (failure) throw failure.error;
  }
  return results;
}
