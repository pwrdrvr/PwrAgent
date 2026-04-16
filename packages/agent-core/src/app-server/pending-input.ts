type PendingInputRequest = {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
  respond: (response: unknown) => void | Promise<void>;
};

type ActivePendingInput = {
  request: PendingInputRequest;
  settled: boolean;
};

type PendingInputCoordinatorOptions = {
  requestClient?: (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown;
  onResolved?: (requestId: string) => Promise<void> | void;
};

export class PendingInputCoordinator {
  private readonly queue: PendingInputRequest[] = [];
  private readonly requestClient;
  private readonly onResolved;
  private currentRequest: ActivePendingInput | null = null;
  private processing = false;
  private readonly idleResolvers: Array<() => void> = [];

  constructor(options: PendingInputCoordinatorOptions) {
    this.requestClient = options.requestClient;
    this.onResolved = options.onResolved;
  }

  enqueue(request: PendingInputRequest): void {
    this.queue.push(request);
    void this.process();
  }

  hasPending(): boolean {
    return this.currentRequest !== null || this.queue.length > 0;
  }

  async cancelPending(response: unknown = { decision: "cancel" }): Promise<void> {
    const active = this.currentRequest;
    if (!active || active.settled) {
      this.resolveIdleIfPossible();
      return;
    }
    active.settled = true;
    await active.request.respond(response);
    await this.onResolved?.(active.request.requestId);
    this.currentRequest = null;
    this.resolveIdleIfPossible();
  }

  waitForIdle(): Promise<void> {
    if (!this.hasPending() && !this.processing) {
      return Promise.resolve();
    }
    return awaitIdle(this.idleResolvers);
  }

  private async process(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.currentRequest === null && this.queue.length > 0) {
        const request = this.queue.shift();
        if (!request) {
          continue;
        }
        const active: ActivePendingInput = {
          request,
          settled: false,
        };
        this.currentRequest = active;
        try {
          const response =
            this.requestClient == null
              ? { decision: "cancel" }
              : await this.requestClient(request.method, request.params);
          if (active.settled) {
            continue;
          }
          active.settled = true;
          await request.respond(response);
          await this.onResolved?.(request.requestId);
        } finally {
          if (this.currentRequest === active) {
            this.currentRequest = null;
          }
          this.resolveIdleIfPossible();
        }
      }
    } finally {
      this.processing = false;
      this.resolveIdleIfPossible();
      if (this.queue.length > 0 && this.currentRequest === null) {
        void this.process();
      }
    }
  }

  private resolveIdleIfPossible(): void {
    if (this.hasPending() || this.processing) {
      return;
    }
    while (this.idleResolvers.length > 0) {
      const resolve = this.idleResolvers.shift();
      resolve?.();
    }
  }
}

function awaitIdle(idleResolvers: Array<() => void>): Promise<void> {
  return new Promise<void>((resolve) => {
    idleResolvers.push(resolve);
  });
}
