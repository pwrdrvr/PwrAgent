type Waiter = {
  enter: () => void;
  previous?: Waiter;
  next?: Waiter;
};

const MAX_WAITING_REQUESTS = 32;

export class ForgeRequestQueueFull extends Error {
  constructor() { super("The forge request queue is full. Retry after a request completes."); }
}

/** FIFO admission for forge transports, with one wakeup per released slot. */
export class ForgeRequestSlots {
  private active = 0;
  private waiting = 0;
  private first?: Waiter;
  private last?: Waiter;

  constructor(private readonly capacity: number) {}

  async run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (this.active < this.capacity) {
      this.active++;
    } else {
      if (this.waiting >= MAX_WAITING_REQUESTS) throw new ForgeRequestQueueFull();
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          previous: this.last,
          enter: () => {
            signal?.removeEventListener("abort", cancel);
            resolve();
          },
        };
        const cancel = () => {
          this.remove(waiter);
          reject(signal?.reason);
        };
        if (this.last) this.last.next = waiter;
        else this.first = waiter;
        this.last = waiter;
        this.waiting++;
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }

    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      const next = this.first;
      if (next) {
        // Transfer the slot before a new caller can claim it.
        this.remove(next);
        next.enter();
      } else {
        this.active--;
      }
    }
  }

  private remove(waiter: Waiter): void {
    if (waiter.previous) waiter.previous.next = waiter.next;
    else this.first = waiter.next;
    if (waiter.next) waiter.next.previous = waiter.previous;
    else this.last = waiter.previous;
    this.waiting--;
  }
}
