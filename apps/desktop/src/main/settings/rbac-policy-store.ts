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
import {
  applyTomlEdits,
  parseTomlTables,
  type TomlEdit,
  type TomlEditScalar,
  type TomlValue,
} from "./toml-editor";

/**
 * Persistence for the per-profile RBAC policy (custom roles + subject→role
 * attachments + the `enforced` flag).
 *
 * Stored in the profile's `config.toml` under `[messaging.rbac]`, with the
 * nested arrays as array-of-tables rows carrying string-array cells:
 *
 *   [messaging.rbac]
 *   enforced = true
 *   policy_version = 1
 *
 *   [[messaging.rbac.roles]]
 *   id = "role_oncall"
 *   name = "On-call"
 *   permissions = ["message.reply", "thread.status.view"]
 *
 *   [[messaging.rbac.attachments]]
 *   platform = "slack"
 *   subject_kind = "actor"
 *   actor_id = "U123"
 *   role_ids = ["admin", "role_oncall"]
 *
 * Earlier revisions of this branch persisted a standalone
 * `rbac-policy.json` because the TOML editor's table-array rows were
 * scalar-only; PR #938 added string-array cells, so the policy now lives with
 * the rest of the messaging config. The JSON file never shipped in a release,
 * but dev profiles may have one — reads fall back to it when `config.toml`
 * has no `[messaging.rbac]` section, and the first TOML write retires it
 * (renamed to `rbac-policy.json.migrated`), per the lazy-conversion rules in
 * `docs/config-file-evolution.md`.
 *
 * Built-in roles are NEVER persisted here — they are code constants
 * (`BUILT_IN_ROLES` in `@pwragent/shared`) so upgrades can extend them. Only
 * custom roles and attachments live in the config.
 *
 * Concurrency: writes are read-modify-write with an atomic tmp+rename, the
 * same unlocked pattern as `applyDesktopSettingsPatch`. Two app instances
 * sharing a profile can last-write-wins each other's config edits — a
 * pre-existing property of all config.toml writers, accepted because policy
 * edits are operator-driven Settings actions, not concurrent hot paths.
 */

export type RbacPolicyStoreOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cliProfile?: string;
  argv?: readonly string[];
};

const RBAC_SECTION = "messaging.rbac";
const RBAC_SECTION_PATH = ["messaging", "rbac"] as const;
const LEGACY_JSON_SEGMENT = "rbac-policy.json";

/** Detects `[messaging.rbac]` / `[[messaging.rbac.*]]` headers in raw TOML. */
const RBAC_HEADER_PATTERN = /^\s*\[\[?\s*messaging\.rbac\b/m;

/**
 * The fail-closed posture: enforcement ON with no permission-granting
 * attachments, so every actor is default-denied (with denial audit rows)
 * until the operator repairs the policy. Returned whenever RBAC data
 * demonstrably exists but cannot be read. The alternative — falling open to
 * legacy mode — would silently promote every admitted actor to Admin the
 * moment a configured policy became unreadable.
 */
function failClosedRbacPolicy(): RbacPolicy {
  return {
    policyVersion: RBAC_POLICY_VERSION,
    enforced: true,
    roles: [],
    attachments: [],
  };
}

export function resolveRbacConfigPath(options?: RbacPolicyStoreOptions): string {
  return resolveActiveProfilePath("config.toml", options);
}

export function resolveLegacyRbacPolicyJsonPath(
  options?: RbacPolicyStoreOptions,
): string {
  return resolveActiveProfilePath(LEGACY_JSON_SEGMENT, options);
}

/**
 * Read the persisted policy. Failure direction is asymmetric by design:
 *
 * - **No RBAC data anywhere** (no config, or config with no `[messaging.rbac]`
 *   section and no legacy JSON) → the empty, UNENFORCED policy. The feature
 *   was never configured, so legacy-compatible mode is correct.
 * - **RBAC data demonstrably exists but cannot be parsed** (malformed TOML
 *   whose raw text still contains a `[messaging.rbac]` header, or an
 *   unparseable legacy JSON file) → FAIL CLOSED: enforced with zero
 *   attachments, default-denying everyone until the operator repairs it.
 *   Falling open here would silently re-promote every admitted actor to
 *   Admin — the exact regression enforcement was configured to prevent.
 *
 * Enforcement turns off only when we affirmatively know it is off.
 */
export function readRbacPolicy(options?: RbacPolicyStoreOptions): RbacPolicy {
  return readRbacPolicyState(options).policy;
}

export type RbacPolicyReadState = {
  policy: RbacPolicy;
  /**
   * True when the policy came from the fail-closed path — RBAC data exists on
   * disk but could not be parsed, so enforcement is locked ON with zero
   * attachments. The Access Control pane surfaces this so the operator knows
   * to repair the file instead of puzzling over an empty enforced graph.
   */
  failClosed: boolean;
};

/** `readRbacPolicy` plus the fail-closed flag for surfacing in the UI. */
export function readRbacPolicyState(
  options?: RbacPolicyStoreOptions,
): RbacPolicyReadState {
  const configPath = resolveRbacConfigPath(options);
  let source: string | null;
  try {
    source = fs.readFileSync(configPath, "utf8");
  } catch {
    source = null;
  }
  if (source !== null) {
    let tables: ReturnType<typeof parseTomlTables>;
    try {
      tables = parseTomlTables(source, configPath);
    } catch {
      return RBAC_HEADER_PATTERN.test(source)
        ? { policy: failClosedRbacPolicy(), failClosed: true }
        : readLegacyJsonPolicyState(options);
    }
    const section = tables[RBAC_SECTION];
    if (section !== undefined) {
      return { policy: policyFromSection(section), failClosed: false };
    }
  }
  return readLegacyJsonPolicyState(options);
}

/**
 * Persist the policy into `config.toml` via targeted TOML edits (comments and
 * unrelated sections preserved), atomically (tmp file + rename). Retires the
 * legacy JSON file on success.
 */
export function writeRbacPolicy(
  policy: RbacPolicy,
  options?: RbacPolicyStoreOptions,
): void {
  const configPath = resolveRbacConfigPath(options);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const source = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";

  const roles = policy.roles.map(normalizeRole);
  const attachments = policy.attachments.map(normalizeAttachment);
  const edits: TomlEdit[] = [
    { op: "set", path: [...RBAC_SECTION_PATH, "enforced"], value: Boolean(policy.enforced) },
    { op: "set", path: [...RBAC_SECTION_PATH, "policy_version"], value: RBAC_POLICY_VERSION },
    { op: "delete", path: [...RBAC_SECTION_PATH, "roles"] },
    { op: "deleteTableArray", path: [...RBAC_SECTION_PATH, "roles"] },
    { op: "delete", path: [...RBAC_SECTION_PATH, "attachments"] },
    { op: "deleteTableArray", path: [...RBAC_SECTION_PATH, "attachments"] },
  ];
  if (roles.length > 0) {
    edits.push({
      op: "setTableArray",
      path: [...RBAC_SECTION_PATH, "roles"],
      value: roles.map(roleToRow),
    });
  }
  if (attachments.length > 0) {
    edits.push({
      op: "setTableArray",
      path: [...RBAC_SECTION_PATH, "attachments"],
      value: attachments.map(attachmentToRow),
    });
  }

  const next = applyTomlEdits(source, edits);
  if (next !== source) {
    const tmpPath = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, next, "utf8");
    fs.renameSync(tmpPath, configPath);
  }
  retireLegacyJsonPolicy(options);
}

// ---------------------------------------------------------------------------
// TOML row mapping
// ---------------------------------------------------------------------------

type TomlRow = Record<string, TomlEditScalar | readonly string[]>;
type ParsedTomlRow = Record<string, TomlEditScalar | string[]>;

function roleToRow(role: RbacRoleDefinition): TomlRow {
  return {
    id: role.id,
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    ...(role.danger ? { danger: true } : {}),
    permissions: [...role.permissions],
  };
}

function attachmentToRow(attachment: RbacAttachment): TomlRow {
  const subject = attachment.subject;
  return {
    platform: subject.platform,
    subject_kind: subject.kind,
    ...(subject.kind === "actor"
      ? { actor_id: subject.actorId }
      : {
          bucket: subject.bucket,
          ...(subject.scopeId ? { scope_id: subject.scopeId } : {}),
        }),
    role_ids: [...attachment.roleIds],
    ...(attachment.displayName ? { display_name: attachment.displayName } : {}),
  };
}

function policyFromSection(section: Record<string, TomlValue>): RbacPolicy {
  return {
    policyVersion:
      typeof section.policy_version === "number"
        ? section.policy_version
        : RBAC_POLICY_VERSION,
    // The section exists, so RBAC is configured: only a clean `enforced =
    // false` turns enforcement off. A missing or garbled flag fails closed.
    enforced: section.enforced !== false,
    roles: rowsOf(section.roles)
      .map(roleFromRow)
      .filter((role): role is RbacRoleDefinition => role !== null),
    attachments: rowsOf(section.attachments)
      .map(attachmentFromRow)
      .filter((attachment): attachment is RbacAttachment => attachment !== null),
  };
}

function rowsOf(value: TomlValue | undefined): ParsedTomlRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ParsedTomlRow =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function roleFromRow(row: ParsedTomlRow): RbacRoleDefinition | null {
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  if (typeof row.name !== "string") return null;
  return {
    id: row.id,
    name: row.name,
    ...(typeof row.description === "string" && row.description.length > 0
      ? { description: row.description }
      : {}),
    // Persisted roles are always custom; built-ins are code constants.
    builtIn: false,
    ...(row.danger === true ? { danger: true } : {}),
    permissions: readStringArrayCell(row.permissions) as RbacRoleDefinition["permissions"],
  };
}

function attachmentFromRow(row: ParsedTomlRow): RbacAttachment | null {
  const subject = subjectFromRow(row);
  if (!subject) return null;
  return {
    subject,
    roleIds: readStringArrayCell(row.role_ids),
    ...(typeof row.display_name === "string" && row.display_name.length > 0
      ? { displayName: row.display_name }
      : {}),
  };
}

function subjectFromRow(row: ParsedTomlRow): RbacSubject | null {
  if (typeof row.platform !== "string" || row.platform.length === 0) return null;
  const platform = row.platform as RbacSubject["platform"];
  if (row.subject_kind === "actor") {
    if (typeof row.actor_id !== "string" || row.actor_id.length === 0) {
      return null;
    }
    return { kind: "actor", platform, actorId: row.actor_id };
  }
  if (row.subject_kind === "bucket") {
    if (!BUCKET_KINDS.includes(row.bucket as RbacBucketKind)) return null;
    return {
      kind: "bucket",
      platform,
      bucket: row.bucket as RbacBucketKind,
      ...(typeof row.scope_id === "string" && row.scope_id.length > 0
        ? { scopeId: row.scope_id }
        : {}),
    };
  }
  return null;
}

function readStringArrayCell(value: TomlEditScalar | string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

// ---------------------------------------------------------------------------
// Legacy standalone-JSON fallback (pre-#938 dev profiles; never shipped)
// ---------------------------------------------------------------------------

function readLegacyJsonPolicyState(
  options?: RbacPolicyStoreOptions,
): RbacPolicyReadState {
  const legacyPath = resolveLegacyRbacPolicyJsonPath(options);
  if (!fs.existsSync(legacyPath)) {
    return { policy: emptyRbacPolicy(), failClosed: false };
  }
  // From here on RBAC data demonstrably exists — unreadable or unparseable
  // states fail closed rather than falling open to everyone-is-Admin.
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
  } catch {
    return { policy: failClosedRbacPolicy(), failClosed: true };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { policy: failClosedRbacPolicy(), failClosed: true };
  }
  return { policy: sanitizeRbacPolicy(parsed), failClosed: false };
}

/**
 * Once the policy lives in `config.toml`, a lingering JSON file would only
 * confuse (and could silently resurrect stale policy if the operator ever
 * removed the TOML section). Rename rather than delete so nothing is lost.
 */
function retireLegacyJsonPolicy(options?: RbacPolicyStoreOptions): void {
  const legacyPath = resolveLegacyRbacPolicyJsonPath(options);
  try {
    if (fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, `${legacyPath}.migrated`);
    }
  } catch {
    // Best-effort: a failed rename leaves the ignored file in place.
  }
}

// ---------------------------------------------------------------------------
// Sanitizers — keep the readers defensive against hand-edited / corrupt files.
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
