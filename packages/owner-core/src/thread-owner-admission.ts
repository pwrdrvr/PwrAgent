import type { RuntimeLeaseManager } from "./runtime-lease-manager";

/** Application port: passive viewers need no claim; provider owners do. */
export interface ThreadOwnerAdmission {
  assertOwnership(): void;
  close(): void;
}

/** Shares Outpost's existing PID-owned lease without coupling it to services. */
export class ProfileThreadOwnerAdmission implements ThreadOwnerAdmission {
  private closed = false;
  private admitted = false;
  private manager?: RuntimeLeaseManager;

  constructor(private readonly leases: RuntimeLeaseManager | (() => RuntimeLeaseManager)) {}

  assertOwnership(): void {
    if (this.closed) throw new Error("Profile thread owner is closed");
    const result = this.getManager().acquire("federation", "thread_owner");
    if (!result.acquired) {
      throw new Error(`Profile thread ownership is held by another PwrAgent runtime (${result.holder.instanceId}); stop that owner before starting local work`);
    }
    this.admitted = true;
  }

  close(): void {
    if (this.closed) return;
    if (this.admitted) this.getManager().release("federation", "thread_owner");
    this.closed = true;
  }

  private getManager(): RuntimeLeaseManager {
    return this.manager ??= typeof this.leases === "function" ? this.leases() : this.leases;
  }
}
