import { createHash } from "node:crypto";
import path from "node:path";
import type { StateDb } from "./state-db.js";

const MESSAGING_LEASE_KEY = "profile-messaging";
const FEDERATION_LEASE_KEY = "profile-federation";
const PID_OWNED_LEASE_EXPIRES_AT = Number.MAX_SAFE_INTEGER;
export const RUNTIME_LEASE_DEAD_OWNER_GRACE_MS = 60_000;

export type AppRuntimeMessagingDisabledReason =
  | "explicit_override"
  | "lease_held"
  | "no_runnable_adapters"
  | "runtime_stopped"
  | "startup_error";

export type AppRuntimeInstanceRecord = {
  instanceId: string;
  profileName: string;
  processId: number;
  cwdHint?: string;
  cwdHash?: string;
  startedAt: number;
  heartbeatAt: number;
  exitedAt?: number;
  desiredMessagingEnabled: boolean;
  effectiveMessagingEnabled: boolean;
  disabledReason?: AppRuntimeMessagingDisabledReason;
};

export type MessagingRuntimeLeaseRecord = {
  ownerInstanceId: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  releasedAt?: number;
  status: "active" | "released" | "expired";
};

export type MessagingLeaseAcquireResult =
  | { acquired: true; lease: MessagingRuntimeLeaseRecord }
  | {
      acquired: false;
      reason: "held";
      holder: MessagingRuntimeLeaseRecord;
    };

// The federation lease shares the messaging lease table (keyed by lease_key)
// and record shape; only the lease key and the per-instance side effects
// differ.
export type FederationRuntimeLeaseRecord = MessagingRuntimeLeaseRecord;
export type FederationLeaseAcquireResult = MessagingLeaseAcquireResult;

type InstanceRow = {
  instance_id: string;
  profile_name: string;
  process_id: number;
  cwd_hint: string | null;
  cwd_hash: string | null;
  started_at: number;
  heartbeat_at: number;
  exited_at: number | null;
  desired_messaging_enabled: number;
  effective_messaging_enabled: number;
  disabled_reason: string | null;
};

type LeaseRow = {
  owner_instance_id: string;
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
  released_at: number | null;
  status: "active" | "released" | "expired";
};

export class AppRuntimeInstanceStore {
  constructor(private readonly stateDb: StateDb) {}

  recordInstanceStart(params: {
    instanceId: string;
    profileName: string;
    processId: number;
    cwd?: string;
    cwdHash?: string;
    startedAt: number;
    desiredMessagingEnabled: boolean;
    effectiveMessagingEnabled?: boolean;
    disabledReason?: string;
  }): AppRuntimeInstanceRecord {
    const disabledReason = normalizeDisabledReason(params.disabledReason);
    const effectiveMessagingEnabled =
      params.effectiveMessagingEnabled ?? (disabledReason ? false : false);

    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO app_runtime_instances(
           instance_id, profile_name, process_id, cwd_hint, cwd_hash, started_at,
           heartbeat_at, exited_at, desired_messaging_enabled,
           effective_messaging_enabled, disabled_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        params.instanceId,
        params.profileName,
        params.processId,
        sanitizeCwdHint(params.cwd),
        params.cwdHash ?? hashCwd(params.cwd),
        params.startedAt,
        params.startedAt,
        booleanToSql(params.desiredMessagingEnabled),
        booleanToSql(effectiveMessagingEnabled),
        disabledReason ?? null,
      );

    return this.getInstance(params.instanceId)!;
  }

  getInstance(instanceId: string): AppRuntimeInstanceRecord | undefined {
    const row = this.stateDb.raw
      .prepare("SELECT * FROM app_runtime_instances WHERE instance_id = ?")
      .get(instanceId) as InstanceRow | undefined;
    return row ? mapInstanceRow(row) : undefined;
  }

  markDesiredMessaging(params: {
    instanceId: string;
    desiredMessagingEnabled: boolean;
    effectiveMessagingEnabled: boolean;
    disabledReason?: AppRuntimeMessagingDisabledReason;
    now: number;
  }): void {
    this.stateDb.raw
      .prepare(
        `UPDATE app_runtime_instances
         SET desired_messaging_enabled = ?,
             effective_messaging_enabled = ?,
             disabled_reason = ?,
             heartbeat_at = ?
         WHERE instance_id = ?`,
      )
      .run(
        booleanToSql(params.desiredMessagingEnabled),
        booleanToSql(params.effectiveMessagingEnabled),
        params.disabledReason ?? null,
        params.now,
        params.instanceId,
      );
  }

  markInstanceExited(params: { instanceId: string; now: number }): void {
    this.stateDb.raw
      .prepare(
        `UPDATE app_runtime_instances
         SET exited_at = ?, heartbeat_at = ?
         WHERE instance_id = ?`,
      )
      .run(params.now, params.now, params.instanceId);
  }

  acquireMessagingLease(params: {
    instanceId: string;
    isOwnerAlive?: (owner: AppRuntimeInstanceRecord) => boolean;
    now: number;
  }): MessagingLeaseAcquireResult {
    return this.acquireLease({
      leaseKey: MESSAGING_LEASE_KEY,
      ...params,
      onHeld: () =>
        this.markDesiredMessaging({
          instanceId: params.instanceId,
          desiredMessagingEnabled: true,
          effectiveMessagingEnabled: false,
          disabledReason: "lease_held",
          now: params.now,
        }),
      onAcquired: () =>
        this.markDesiredMessaging({
          instanceId: params.instanceId,
          desiredMessagingEnabled: true,
          effectiveMessagingEnabled: true,
          now: params.now,
        }),
    });
  }

  acquireFederationLease(params: {
    instanceId: string;
    isOwnerAlive?: (owner: AppRuntimeInstanceRecord) => boolean;
    now: number;
  }): FederationLeaseAcquireResult {
    return this.acquireLease({ leaseKey: FEDERATION_LEASE_KEY, ...params });
  }

  releaseMessagingLease(params: { instanceId: string; now: number }): boolean {
    return this.releaseLease({
      leaseKey: MESSAGING_LEASE_KEY,
      ...params,
      onReleased: () =>
        this.markDesiredMessaging({
          instanceId: params.instanceId,
          desiredMessagingEnabled: true,
          effectiveMessagingEnabled: false,
          disabledReason: "runtime_stopped",
          now: params.now,
        }),
    });
  }

  releaseFederationLease(params: { instanceId: string; now: number }): boolean {
    return this.releaseLease({ leaseKey: FEDERATION_LEASE_KEY, ...params });
  }

  getMessagingLease(): MessagingRuntimeLeaseRecord | undefined {
    return this.readLease(MESSAGING_LEASE_KEY);
  }

  getFederationLease(): FederationRuntimeLeaseRecord | undefined {
    return this.readLease(FEDERATION_LEASE_KEY);
  }

  private acquireLease(params: {
    leaseKey: string;
    instanceId: string;
    isOwnerAlive?: (owner: AppRuntimeInstanceRecord) => boolean;
    now: number;
    onHeld?: () => void;
    onAcquired?: () => void;
  }): MessagingLeaseAcquireResult {
    const acquire = this.stateDb.raw.transaction(() => {
      const existing = this.readLease(params.leaseKey);
      if (
        existing
        && existing.status === "active"
        && existing.ownerInstanceId !== params.instanceId
      ) {
        const owner = this.getInstance(existing.ownerInstanceId);
        if (owner?.exitedAt !== undefined) {
          const reclaimAt = owner.exitedAt + RUNTIME_LEASE_DEAD_OWNER_GRACE_MS;
          if (existing.expiresAt !== reclaimAt) {
            this.setLeaseExpiry({
              leaseKey: params.leaseKey,
              ownerInstanceId: existing.ownerInstanceId,
              expiresAt: reclaimAt,
            });
          }
          if (params.now < reclaimAt) {
            return this.heldResult(params, this.readLease(params.leaseKey)!);
          }
        } else if (owner && (params.isOwnerAlive?.(owner) ?? true)) {
          return this.heldResult(params, existing);
        } else if (
          !owner
          && existing.expiresAt !== PID_OWNED_LEASE_EXPIRES_AT
        ) {
          if (params.now < existing.expiresAt) {
            return this.heldResult(params, existing);
          }
        } else {
          const reclaimAt = params.now + RUNTIME_LEASE_DEAD_OWNER_GRACE_MS;
          if (owner) {
            this.markInstanceExited({
              instanceId: owner.instanceId,
              now: params.now,
            });
          }
          this.setLeaseExpiry({
            leaseKey: params.leaseKey,
            ownerInstanceId: existing.ownerInstanceId,
            expiresAt: reclaimAt,
          });
          return this.heldResult(params, this.readLease(params.leaseKey)!);
        }
      }

      if (
        existing
        && existing.status === "active"
        && existing.ownerInstanceId === params.instanceId
      ) {
        params.onAcquired?.();
        return { acquired: true as const, lease: existing };
      }

      const lease = this.upsertActiveLease({
        leaseKey: params.leaseKey,
        instanceId: params.instanceId,
        acquiredAt: params.now,
        now: params.now,
      });
      params.onAcquired?.();
      return { acquired: true as const, lease };
    });
    // Serialize liveness observation, grace-deadline persistence, and eventual
    // replacement so challengers cannot disagree about or both claim an owner.
    return acquire.immediate();
  }

  private heldResult(
    params: { onHeld?: () => void },
    holder: MessagingRuntimeLeaseRecord,
  ): MessagingLeaseAcquireResult {
    params.onHeld?.();
    return {
      acquired: false,
      reason: "held",
      holder,
    };
  }

  private setLeaseExpiry(params: {
    leaseKey: string;
    ownerInstanceId: string;
    expiresAt: number;
  }): void {
    this.stateDb.raw
      .prepare(
        `UPDATE messaging_runtime_lease
         SET expires_at = ?
         WHERE lease_key = ? AND owner_instance_id = ? AND status = 'active'`,
      )
      .run(params.expiresAt, params.leaseKey, params.ownerInstanceId);
  }

  private releaseLease(params: {
    leaseKey: string;
    instanceId: string;
    now: number;
    onReleased?: () => void;
  }): boolean {
    return this.stateDb.raw.transaction(() => {
      const existing = this.readLease(params.leaseKey);
      if (
        !existing
        || existing.status !== "active"
        || existing.ownerInstanceId !== params.instanceId
      ) {
        return false;
      }

      this.stateDb.raw
        .prepare(
          `UPDATE messaging_runtime_lease
           SET released_at = ?, status = 'released'
           WHERE lease_key = ? AND owner_instance_id = ?`,
        )
        .run(params.now, params.leaseKey, params.instanceId);
      params.onReleased?.();
      return true;
    })();
  }

  private readLease(leaseKey: string): MessagingRuntimeLeaseRecord | undefined {
    const row = this.stateDb.raw
      .prepare("SELECT * FROM messaging_runtime_lease WHERE lease_key = ?")
      .get(leaseKey) as LeaseRow | undefined;
    return row ? mapLeaseRow(row) : undefined;
  }

  private upsertActiveLease(params: {
    leaseKey: string;
    instanceId: string;
    acquiredAt: number;
    now: number;
  }): MessagingRuntimeLeaseRecord {
    this.stateDb.raw
      .prepare(
        `INSERT INTO messaging_runtime_lease(
           lease_key, owner_instance_id, acquired_at, heartbeat_at,
           expires_at, released_at, status
         ) VALUES (?, ?, ?, ?, ?, NULL, 'active')
         ON CONFLICT(lease_key) DO UPDATE SET
           owner_instance_id = excluded.owner_instance_id,
           acquired_at = excluded.acquired_at,
           heartbeat_at = excluded.heartbeat_at,
           expires_at = excluded.expires_at,
           released_at = NULL,
           status = 'active'`,
      )
      .run(
        params.leaseKey,
        params.instanceId,
        params.acquiredAt,
        params.now,
        PID_OWNED_LEASE_EXPIRES_AT,
      );
    return this.readLease(params.leaseKey)!;
  }
}

function mapInstanceRow(row: InstanceRow): AppRuntimeInstanceRecord {
  return {
    instanceId: row.instance_id,
    profileName: row.profile_name,
    processId: row.process_id,
    ...(row.cwd_hint ? { cwdHint: row.cwd_hint } : {}),
    ...(row.cwd_hash ? { cwdHash: row.cwd_hash } : {}),
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    ...(row.exited_at !== null ? { exitedAt: row.exited_at } : {}),
    desiredMessagingEnabled: row.desired_messaging_enabled === 1,
    effectiveMessagingEnabled: row.effective_messaging_enabled === 1,
    ...(row.disabled_reason
      ? {
          disabledReason:
            normalizeDisabledReason(row.disabled_reason) ?? "runtime_stopped",
        }
      : {}),
  };
}

function mapLeaseRow(row: LeaseRow): MessagingRuntimeLeaseRecord {
  return {
    ownerInstanceId: row.owner_instance_id,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    ...(row.released_at !== null ? { releasedAt: row.released_at } : {}),
    status: row.status,
  };
}

function booleanToSql(value: boolean): number {
  return value ? 1 : 0;
}

function sanitizeCwdHint(cwd: string | undefined): string | null {
  const value = cwd?.trim();
  if (!value) return null;
  return path.basename(value).slice(0, 120) || null;
}

export function hashCwd(cwd: string | undefined): string | null {
  const value = cwd?.trim();
  if (!value) return null;
  return createHash("sha256").update(path.resolve(value)).digest("hex").slice(0, 16);
}

function normalizeDisabledReason(
  value: string | undefined,
): AppRuntimeMessagingDisabledReason | undefined {
  switch (value) {
    case "explicit_override":
    case "lease_held":
    case "no_runnable_adapters":
    case "runtime_stopped":
    case "startup_error":
      return value;
    default:
      return value ? "explicit_override" : undefined;
  }
}
