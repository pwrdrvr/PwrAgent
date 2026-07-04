import fs from "node:fs";
import path from "node:path";

import {
  RBAC_POLICY_VERSION,
  emptyRbacPolicy,
  type RbacAttachment,
  type RbacBucketKind,
  type RbacPolicy,
  type RbacRoleDefinition,
  type RbacSubject,
} from "@pwragent/shared";

import { resolveActiveProfilePath } from "../profile";

/**
 * Persistence for the per-profile RBAC policy (custom roles + subject→role
 * attachments + the `enforced` flag).
 *
 * Stored as a dedicated JSON document at the profile root
 * (`~/.pwragent/profiles/<name>/rbac-policy.json`), sibling to `state/`, rather
 * than inside `config.toml`. Two reasons:
 *   1. The policy shape has arrays nested inside table rows (a role's
 *      `permissions`, an attachment's `roleIds`), which the repo's scalar-only
 *      TOML table-array writer (`toml-editor.ts`) cannot express without a
 *      disproportionate extension.
 *   2. A standalone JSON file is still operator-editable and export/importable
 *      (issue #292), and survives independently of both config.toml and the
 *      state.db.
 *
 * Built-in roles are NEVER persisted here — they are code constants
 * (`BUILT_IN_ROLES` in `@pwragent/shared`) so upgrades can extend them. Only
 * custom roles and attachments live in this file.
 */

export type RbacPolicyStoreOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cliProfile?: string;
  argv?: readonly string[];
};

const RBAC_POLICY_SEGMENT = "rbac-policy.json";

export function resolveRbacPolicyPath(options?: RbacPolicyStoreOptions): string {
  return resolveActiveProfilePath(RBAC_POLICY_SEGMENT, options);
}

/**
 * Read the persisted policy. Tolerant by design: a missing file, unreadable
 * file, malformed JSON, or an unrecognized shape all resolve to an empty,
 * unenforced policy so a corrupt file can never brick messaging authorization
 * (it fails safe to legacy-compatible mode).
 */
export function readRbacPolicy(options?: RbacPolicyStoreOptions): RbacPolicy {
  const policyPath = resolveRbacPolicyPath(options);
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, "utf8");
  } catch {
    return emptyRbacPolicy();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyRbacPolicy();
  }
  return sanitizeRbacPolicy(parsed);
}

/** Atomically persist the policy (tmp file + rename), creating dirs as needed. */
export function writeRbacPolicy(
  policy: RbacPolicy,
  options?: RbacPolicyStoreOptions,
): void {
  const policyPath = resolveRbacPolicyPath(options);
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  const normalized: RbacPolicy = {
    policyVersion: RBAC_POLICY_VERSION,
    enforced: Boolean(policy.enforced),
    roles: policy.roles.map(normalizeRole),
    attachments: policy.attachments.map(normalizeAttachment),
  };
  const tmpPath = `${policyPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, policyPath);
}

// ---------------------------------------------------------------------------
// Sanitizers — keep the reader defensive against hand-edited / corrupt files.
// ---------------------------------------------------------------------------

function sanitizeRbacPolicy(value: unknown): RbacPolicy {
  if (typeof value !== "object" || value === null) {
    return emptyRbacPolicy();
  }
  const record = value as Record<string, unknown>;
  const roles = Array.isArray(record.roles)
    ? record.roles.map(sanitizeRole).filter((role): role is RbacRoleDefinition => role !== null)
    : [];
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
        .map(sanitizeAttachment)
        .filter((attachment): attachment is RbacAttachment => attachment !== null)
    : [];
  return {
    policyVersion:
      typeof record.policyVersion === "number"
        ? record.policyVersion
        : RBAC_POLICY_VERSION,
    enforced: record.enforced === true,
    roles,
    attachments,
  };
}

function sanitizeRole(value: unknown): RbacRoleDefinition | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.name !== "string") return null;
  const permissions = Array.isArray(record.permissions)
    ? record.permissions.filter((p): p is string => typeof p === "string")
    : [];
  return {
    id: record.id,
    name: record.name,
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    // Persisted roles are always custom; built-ins are code constants.
    builtIn: false,
    ...(record.danger === true ? { danger: true } : {}),
    permissions: permissions as RbacRoleDefinition["permissions"],
  };
}

function normalizeRole(role: RbacRoleDefinition): RbacRoleDefinition {
  return {
    id: role.id,
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    builtIn: false,
    ...(role.danger ? { danger: true } : {}),
    permissions: [...role.permissions],
  };
}

const BUCKET_KINDS: readonly RbacBucketKind[] = [
  "channel_any_user",
  "dm_any_workspace_user",
];

function sanitizeSubject(value: unknown): RbacSubject | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.platform !== "string") return null;
  const platform = record.platform as RbacSubject["platform"];
  if (record.kind === "actor") {
    if (typeof record.actorId !== "string" || record.actorId.length === 0) {
      return null;
    }
    return { kind: "actor", platform, actorId: record.actorId };
  }
  if (record.kind === "bucket") {
    if (!BUCKET_KINDS.includes(record.bucket as RbacBucketKind)) return null;
    return {
      kind: "bucket",
      platform,
      bucket: record.bucket as RbacBucketKind,
      ...(typeof record.scopeId === "string" && record.scopeId.length > 0
        ? { scopeId: record.scopeId }
        : {}),
    };
  }
  return null;
}

function sanitizeAttachment(value: unknown): RbacAttachment | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const subject = sanitizeSubject(record.subject);
  if (!subject) return null;
  const roleIds = Array.isArray(record.roleIds)
    ? record.roleIds.filter((id): id is string => typeof id === "string")
    : [];
  return {
    subject,
    roleIds,
    ...(typeof record.displayName === "string"
      ? { displayName: record.displayName }
      : {}),
  };
}

function normalizeAttachment(attachment: RbacAttachment): RbacAttachment {
  return {
    subject: attachment.subject,
    roleIds: [...attachment.roleIds],
    ...(attachment.displayName ? { displayName: attachment.displayName } : {}),
  };
}
