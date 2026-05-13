import { createHash } from "node:crypto";
import path from "node:path";
import type { StateDb } from "./state-db.js";

const MESSAGING_LEASE_KEY = "profile-messaging";

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

  heartbeatInstance(params: { instanceId: string; now: number }): void {
    this.stateDb.raw
      .prepare(
        "UPDATE app_runtime_instances SET heartbeat_at = ? WHERE instance_id = ?",
      )
      .run(params.now, params.instanceId);
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
    now: number;
    ttlMs: number;
  }): MessagingLeaseAcquireResult {
    return this.stateDb.raw.transaction(() => {
      const existing = this.getMessagingLease();
      if (
        existing
        && existing.status === "active"
        && existing.ownerInstanceId !== params.instanceId
        && existing.expiresAt > params.now
      ) {
        this.markDesiredMessaging({
          instanceId: params.instanceId,
          desiredMessagingEnabled: true,
          effectiveMessagingEnabled: false,
          disabledReason: "lease_held",
          now: params.now,
        });
        return { acquired: false as const, reason: "held" as const, holder: existing };
      }

      const acquiredAt =
        existing?.status === "active"
        && existing.ownerInstanceId === params.instanceId
        && existing.expiresAt > params.now
          ? existing.acquiredAt
          : params.now;
      const lease = this.upsertActiveLease({
        instanceId: params.instanceId,
        acquiredAt,
        now: params.now,
        ttlMs: params.ttlMs,
      });
      this.markDesiredMessaging({
        instanceId: params.instanceId,
        desiredMessagingEnabled: true,
        effectiveMessagingEnabled: true,
        now: params.now,
      });
      return { acquired: true as const, lease };
    })();
  }

  renewMessagingLease(params: {
    instanceId: string;
    now: number;
    ttlMs: number;
  }): boolean {
    return this.stateDb.raw.transaction(() => {
      const existing = this.getMessagingLease();
      if (
        !existing
        || existing.status !== "active"
        || existing.ownerInstanceId !== params.instanceId
      ) {
        return false;
      }

      this.upsertActiveLease({
        instanceId: params.instanceId,
        acquiredAt: existing.acquiredAt,
        now: params.now,
        ttlMs: params.ttlMs,
      });
      this.markDesiredMessaging({
        instanceId: params.instanceId,
        desiredMessagingEnabled: true,
        effectiveMessagingEnabled: true,
        now: params.now,
      });
      return true;
    })();
  }

  releaseMessagingLease(params: { instanceId: string; now: number }): boolean {
    return this.stateDb.raw.transaction(() => {
      const existing = this.getMessagingLease();
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
        .run(params.now, MESSAGING_LEASE_KEY, params.instanceId);
      this.markDesiredMessaging({
        instanceId: params.instanceId,
        desiredMessagingEnabled: true,
        effectiveMessagingEnabled: false,
        disabledReason: "runtime_stopped",
        now: params.now,
      });
      return true;
    })();
  }

  getMessagingLease(): MessagingRuntimeLeaseRecord | undefined {
    const row = this.stateDb.raw
      .prepare("SELECT * FROM messaging_runtime_lease WHERE lease_key = ?")
      .get(MESSAGING_LEASE_KEY) as LeaseRow | undefined;
    return row ? mapLeaseRow(row) : undefined;
  }

  private upsertActiveLease(params: {
    instanceId: string;
    acquiredAt: number;
    now: number;
    ttlMs: number;
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
        MESSAGING_LEASE_KEY,
        params.instanceId,
        params.acquiredAt,
        params.now,
        params.now + params.ttlMs,
      );
    this.heartbeatInstance({ instanceId: params.instanceId, now: params.now });
    return this.getMessagingLease()!;
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
