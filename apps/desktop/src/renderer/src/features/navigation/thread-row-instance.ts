/** A displayed occurrence, independent of the thread open in the detail pane. */
export type ThreadRowInstance = {
  /** threadSummaryIdentityKey(thread), including its federation owner. */
  threadKey: string;
  /** Absent in lenses without project sections. */
  directoryKey?: string;
  /** The root whose flat descendant tray contains this row. */
  parentThreadKey?: string;
};

export function threadRowInstanceKey(row: ThreadRowInstance): string {
  return JSON.stringify([row.directoryKey ?? null, row.parentThreadKey ?? null, row.threadKey]);
}
