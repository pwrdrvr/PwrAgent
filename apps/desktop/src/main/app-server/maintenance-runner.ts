import { IterableQueueMapperSimple } from "@shutterstock/p-map-iterable";

export const MAINTENANCE_CONCURRENCY = 4;

/** Bound accepted work and drain every started task before returning. */
export async function runMaintenanceItems<T>(items: readonly T[], work: (item: T, index: number) => Promise<void>): Promise<void> {
  const mapper = new IterableQueueMapperSimple<number>(async (index) => await work(items[index]!, index), {
    concurrency: MAINTENANCE_CONCURRENCY,
  });
  for (let index = 0; index < items.length; index++) await mapper.enqueue(index);
  await mapper.onIdle();
  if (mapper.errors.length) throw mapper.errors[0]!.error;
}
