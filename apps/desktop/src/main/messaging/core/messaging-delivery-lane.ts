/**
 * One first-in, first-out line per delivery scope, for deliveries the budget
 * has to hold back.
 *
 * Without it, deliveries waiting out a cool-off each slept on their own
 * timer. When a second 429 extended the cool-off, an earlier delivery woke,
 * was deferred again and re-armed its timer behind a later one, so the later
 * reply reached the chat first. With a line, only the delivery at the head
 * may be admitted and sent; the next one moves up when the head's provider
 * call has finished or it has given up.
 *
 * The runtime keeps one lane per platform for its own lifetime, beside the
 * delivery budget, so a delivery keeps its place when its adapter restarts.
 */
export type MessagingDeliveryLaneTicket = {
  /** Settles when this ticket reaches the head of its line. */
  readonly ready: Promise<void>;
  /** Leave the line. Safe to call more than once. */
  release(): void;
};

type Waiter = {
  released: boolean;
  resolve: () => void;
};

export class MessagingDeliveryLane {
  private readonly lines = new Map<string, Waiter[]>();

  /** True while any delivery for the scope is waiting or sending in line. */
  isOccupied(scopeId: string): boolean {
    return (this.lines.get(scopeId)?.length ?? 0) > 0;
  }

  enter(scopeId: string): MessagingDeliveryLaneTicket {
    let line = this.lines.get(scopeId);
    if (!line) {
      line = [];
      this.lines.set(scopeId, line);
    }
    let resolve!: () => void;
    const ready = new Promise<void>((settle) => {
      resolve = settle;
    });
    const waiter: Waiter = { released: false, resolve };
    line.push(waiter);
    if (line[0] === waiter) {
      resolve();
    }
    return {
      ready,
      release: () => this.release(scopeId, waiter),
    };
  }

  private release(scopeId: string, waiter: Waiter): void {
    if (waiter.released) return;
    waiter.released = true;
    const line = this.lines.get(scopeId);
    if (!line) return;
    const index = line.indexOf(waiter);
    if (index < 0) return;
    line.splice(index, 1);
    if (line.length === 0) {
      this.lines.delete(scopeId);
      return;
    }
    if (index === 0) {
      line[0]?.resolve();
    }
  }
}
