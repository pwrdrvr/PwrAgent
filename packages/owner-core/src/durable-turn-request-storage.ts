import type { DurableTurnReceipt, DurableSteerReceipt } from "@pwragent/shared";

export type DurableRequestReceipt = DurableTurnReceipt | DurableSteerReceipt;

/** Durable owner inbox operations. Work is synchronous; dispatch runs outside
 * the transaction. Implementations commit FULL/immediate before returning. */
export interface DurableTurnRequestStorage {
  transaction<T>(work: () => T): T;
  read(scope: string, id: string): DurableRequestReceipt | undefined;
  write(scope: string, receipt: DurableRequestReceipt): void;
  pruneExpired(now: number): void;
  count(scope?: string): number;
  insert(scope: string, receipt: DurableRequestReceipt): void;
  readQueueReceipt(queueEntryId: string): DurableTurnReceipt | undefined;
  findQueueReceipt(queueEntryId: string): { scope: string; receipt: DurableTurnReceipt } | undefined;
}
