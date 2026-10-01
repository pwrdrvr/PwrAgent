import type { AppServerBackendKind } from "@pwragent/shared";

type ArchiveEvidence = { generation: number; threadIds: ReadonlySet<string> };
type Scope = {
  generation: number;
  expiresAt: number;
  evidence?: ArchiveEvidence;
  pending?: Promise<ArchiveEvidence>;
};

/** Archive membership has a different lifetime from turn/display metadata. */
export class ArchiveCleanupReadPool {
  private readonly scopes = new Map<AppServerBackendKind, Scope>();

  constructor(
    private readonly reuseWindowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(backend?: AppServerBackendKind): void {
    const scopes = backend ? [this.scope(backend)] : this.scopes.values();
    for (const scope of scopes) {
      scope.generation += 1;
      scope.evidence = undefined;
      scope.expiresAt = 0;
      // Keep ownership of a stale physical read until it settles. Otherwise a
      // replacement can attach to the provider's still-pending stale listing.
    }
  }

  isCurrent(backend: AppServerBackendKind, evidence: ArchiveEvidence): boolean {
    return this.scope(backend).generation === evidence.generation;
  }

  async read(
    backend: AppServerBackendKind,
    load: () => Promise<ReadonlySet<string>>,
  ): Promise<ArchiveEvidence> {
    const scope = this.scope(backend);
    // Background cleanup has no user cancellation owner. Bound retries under
    // sustained archive mutations; a later active refresh can try again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (scope.evidence && scope.expiresAt > this.now()) return scope.evidence;
      if (!scope.pending) {
        const generation = scope.generation;
        const pending = Promise.resolve().then(load).then((threadIds) => {
          const evidence = { generation, threadIds };
          if (scope.generation === generation) {
            scope.evidence = evidence;
            scope.expiresAt = this.now() + this.reuseWindowMs;
          }
          return evidence;
        }).finally(() => {
          if (scope.pending === pending) scope.pending = undefined;
        });
        scope.pending = pending;
      }
      const evidence = await scope.pending;
      if (this.isCurrent(backend, evidence)) return evidence;
    }
    throw new Error("Archive membership changed during three cleanup reads; retry on the next refresh.");
  }

  private scope(backend: AppServerBackendKind): Scope {
    let scope = this.scopes.get(backend);
    if (!scope) {
      scope = { generation: 0, expiresAt: 0 };
      this.scopes.set(backend, scope);
    }
    return scope;
  }
}
