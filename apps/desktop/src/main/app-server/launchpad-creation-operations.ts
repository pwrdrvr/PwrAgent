import type {
  LaunchpadCreationRequest,
  LaunchpadCreationResponse,
  LaunchpadCreationStatus,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
} from "@pwragent/shared";

export class LaunchpadCreationCancelledError extends Error {
  constructor() {
    super("Thread startup cancelled. The submitted draft has been retained.");
    this.name = "LaunchpadCreationCancelledError";
  }
}

export class LaunchpadCreationOperation {
  readonly controller = new AbortController();
  readonly status: LaunchpadCreationStatus;
  promise?: Promise<MaterializeDirectoryLaunchpadResponse>;
  actionRunId?: string;
  workspaceRollback?: () => Promise<void>;

  constructor(request: MaterializeDirectoryLaunchpadRequest) {
    const now = Date.now();
    this.status = {
      operationId: request.operationId!,
      directoryKey: request.directoryKey,
      backend: request.launchpad?.backend,
      projectPath: request.launchpad?.directoryPath,
      title: request.input?.find((item) => item.type === "text")?.text ?? request.launchpad?.prompt,
      submittedAt: Number.isFinite(request.submittedAt) ? request.submittedAt! : now,
      startedAt: now,
      updatedAt: now,
      phase: "preparing",
      cancellable: true,
    };
  }

  check(): void {
    if (this.controller.signal.aborted) throw new LaunchpadCreationCancelledError();
  }

  update(update: Partial<LaunchpadCreationStatus>): void {
    Object.assign(this.status, update, { updatedAt: Date.now() });
  }

  /** No await between this gate and dispatch: cancellation has one ordering. */
  commit(): void {
    this.check();
    this.update({ phase: "dispatching", cancellable: false });
  }
}

/** Owner-memory only: output events and elapsed ticks never write SQLite. */
export class LaunchpadCreationOperations {
  private readonly operations = new Map<string, LaunchpadCreationOperation>();
  private readonly cancelledBeforeStart = new Map<string, number>();

  cancelAll(): void {
    for (const operation of this.operations.values()) {
      if (operation.status.cancellable && !operation.status.finishedAt) operation.controller.abort();
    }
  }

  private key(operationId: string, sourceInstanceId?: string): string {
    if (!operationId || operationId.length > 200) throw new Error("Invalid startup operation ID");
    return JSON.stringify([sourceInstanceId ?? "local", operationId]);
  }

  private prune(): void {
    const expiredBefore = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, operation] of this.operations) {
      if (operation.status.finishedAt && operation.status.finishedAt < expiredBefore) this.operations.delete(key);
    }
    for (const [key, at] of this.cancelledBeforeStart) {
      if (at < expiredBefore) this.cancelledBeforeStart.delete(key);
    }
  }

  manage(request: LaunchpadCreationRequest, sourceInstanceId?: string): LaunchpadCreationResponse {
    this.prune();
    const key = this.key(request.operationId, sourceInstanceId);
    const operation = this.operations.get(key);
    let cancellationAccepted: boolean | undefined;
    if (request.action === "cancel") {
      cancellationAccepted = !operation || operation.status.cancellable || operation.controller.signal.aborted;
      if (!operation) {
        // A cancel can overtake request preparation/attachment transfer. Keep
        // a tombstone so its eventual request cannot create a thread.
        this.cancelledBeforeStart.set(key, Date.now());
      } else if (cancellationAccepted && !operation.status.finishedAt) {
        operation.update({ phase: "cancelling", cancellable: false });
        operation.controller.abort();
      }
    }
    return { operation: operation ? structuredClone(operation.status) : undefined, cancellationAccepted };
  }

  run(
    request: MaterializeDirectoryLaunchpadRequest,
    sourceInstanceId: string | undefined,
    work: (operation: LaunchpadCreationOperation) => Promise<MaterializeDirectoryLaunchpadResponse>,
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    this.prune();
    const key = this.key(request.operationId!, sourceInstanceId);
    const existing = this.operations.get(key);
    if (existing?.promise) return existing.promise;
    const operation = new LaunchpadCreationOperation(request);
    this.operations.set(key, operation);
    if (this.cancelledBeforeStart.has(key)) operation.controller.abort();
    operation.promise = (async () => {
      try {
        operation.check();
        const result = await work(operation);
        operation.update({ result, phase: "completed", finishedAt: Date.now(), cancellable: false });
        return result;
      } catch (error) {
        operation.update({
          phase: error instanceof LaunchpadCreationCancelledError ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error),
          finishedAt: Date.now(),
          cancellable: false,
        });
        throw error;
      }
    })();
    return operation.promise;
  }
}
