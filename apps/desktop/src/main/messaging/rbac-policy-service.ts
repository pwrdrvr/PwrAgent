import {
  BUILT_IN_ROLES,
  RBAC_BUILT_IN_ROLE_IDS,
  resolveEffectivePermissions,
  roleIsDangerous,
  type MessagingChannelKind,
  type RbacAdmittedVia,
  type RbacAttachment,
  type RbacPolicy,
  type RbacResolution,
  type RbacRoleDefinition,
  type RbacSubject,
  type ReadRbacPolicyResponse,
} from "@pwragent/shared";
import { MESSAGING_PERMISSION_CATALOG } from "@pwragent/shared";

import {
  readRbacPolicy,
  writeRbacPolicy,
  type RbacPolicyStoreOptions,
} from "../settings/rbac-policy-store";

/**
 * Per-platform capability resolver injected into each `MessagingController`.
 * The controller stays decoupled from storage — it only asks two questions:
 * "are we enforcing?" and "what may this admitted actor do?".
 */
export interface MessagingRbacPolicyProvider {
  /**
   * False → legacy-compatible mode: every provider-admitted actor is implicitly
   * Admin, exactly as before RBAC shipped. The controller short-circuits its
   * capability checks to allow-all in this mode.
   */
  isEnforcing(): boolean;
  resolve(input: {
    actorId: string;
    conversationId?: string;
    admittedVia?: RbacAdmittedVia;
  }): RbacResolution;
}

/**
 * Process-wide RBAC policy service. One JSON file backs every platform's
 * controller, so the loaded policy is cached here and invalidated on write.
 */
export class RbacPolicyService {
  private cache: RbacPolicy | null = null;

  constructor(private readonly options?: RbacPolicyStoreOptions) {}

  /** Drop the cache so the next read re-loads from disk (call after writes). */
  reload(): void {
    this.cache = null;
  }

  private policy(): RbacPolicy {
    if (!this.cache) {
      this.cache = readRbacPolicy(this.options);
    }
    return this.cache;
  }

  isEnforcing(): boolean {
    return this.policy().enforced;
  }

  /** Built-in roles first, then custom roles from the policy file. */
  allRoles(): RbacRoleDefinition[] {
    return [...BUILT_IN_ROLES, ...this.policy().roles];
  }

  attachments(): RbacAttachment[] {
    return this.policy().attachments;
  }

  /** A provider bound to one platform for controller injection. */
  providerFor(platform: MessagingChannelKind): MessagingRbacPolicyProvider {
    return {
      isEnforcing: () => this.isEnforcing(),
      resolve: (input) =>
        resolveEffectivePermissions({
          platform,
          actorId: input.actorId,
          conversationId: input.conversationId,
          admittedVia: input.admittedVia,
          roles: this.allRoles(),
          attachments: this.attachments(),
        }),
    };
  }

  /** The full policy view for the Access Control settings pane. */
  read(): ReadRbacPolicyResponse {
    const policy = this.policy();
    return {
      enforced: policy.enforced,
      roles: this.allRoles(),
      attachments: policy.attachments,
      permissionCatalog: MESSAGING_PERMISSION_CATALOG,
    };
  }

  // -------------------------------------------------------------------------
  // Mutations (used by IPC). Each persists + invalidates the cache.
  // -------------------------------------------------------------------------

  private mutate(next: (policy: RbacPolicy) => RbacPolicy): void {
    const updated = next(structuredClonePolicy(this.policy()));
    writeRbacPolicy(updated, this.options);
    this.cache = updated;
  }

  /** Create or update a custom role. Built-in role IDs are reserved. */
  upsertRole(role: RbacRoleDefinition): { ok: boolean; error?: string } {
    if (isBuiltInRoleId(role.id)) {
      return { ok: false, error: "Built-in roles cannot be edited." };
    }
    const danger = roleIsDangerous(role.permissions);
    this.mutate((policy) => {
      const roles = policy.roles.filter((existing) => existing.id !== role.id);
      roles.push({
        id: role.id,
        name: role.name,
        ...(role.description ? { description: role.description } : {}),
        builtIn: false,
        ...(danger ? { danger: true } : {}),
        permissions: [...role.permissions],
      });
      return { ...policy, roles };
    });
    return { ok: true };
  }

  deleteRole(roleId: string): { ok: boolean; error?: string } {
    if (isBuiltInRoleId(roleId)) {
      return { ok: false, error: "Built-in roles cannot be deleted." };
    }
    this.mutate((policy) => ({
      ...policy,
      roles: policy.roles.filter((role) => role.id !== roleId),
      // Also strip the deleted role from every attachment so no edge dangles.
      attachments: policy.attachments
        .map((attachment) => ({
          ...attachment,
          roleIds: attachment.roleIds.filter((id) => id !== roleId),
        }))
        .filter((attachment) => attachment.roleIds.length > 0),
    }));
    return { ok: true };
  }

  /** Upsert an attachment (replaces any existing edge for the same subject). */
  upsertAttachment(attachment: RbacAttachment): { ok: boolean; error?: string } {
    this.mutate((policy) => {
      const attachments = policy.attachments.filter(
        (existing) => !sameSubject(existing.subject, attachment.subject),
      );
      if (attachment.roleIds.length > 0) {
        attachments.push({
          subject: attachment.subject,
          roleIds: [...attachment.roleIds],
          ...(attachment.displayName
            ? { displayName: attachment.displayName }
            : {}),
        });
      }
      return { ...policy, attachments };
    });
    return { ok: true };
  }

  deleteAttachment(subject: RbacSubject): { ok: boolean; error?: string } {
    this.mutate((policy) => ({
      ...policy,
      attachments: policy.attachments.filter(
        (existing) => !sameSubject(existing.subject, subject),
      ),
    }));
    return { ok: true };
  }

  /**
   * Flip enforcement on/off. When enabling for the first time, callers pass a
   * synthesized set of attachments (typically actor→Admin for every currently
   * authorized contact plus bucket review rows) so nobody loses access.
   */
  setEnforced(
    enforced: boolean,
    synthesizedAttachments?: RbacAttachment[],
  ): { ok: boolean; error?: string } {
    this.mutate((policy) => ({
      ...policy,
      enforced,
      attachments:
        synthesizedAttachments && policy.attachments.length === 0
          ? synthesizedAttachments.map((attachment) => ({
              subject: attachment.subject,
              roleIds: [...attachment.roleIds],
              ...(attachment.displayName
                ? { displayName: attachment.displayName }
                : {}),
            }))
          : policy.attachments,
    }));
    return { ok: true };
  }
}

/**
 * Process-wide singleton. The messaging runtime (read/resolve) and the RBAC IPC
 * handlers (mutations) share one instance so the in-memory cache stays coherent
 * — a policy write updates the cache the runtime's controllers read from.
 */
let sharedService: RbacPolicyService | null = null;

export function getRbacPolicyService(): RbacPolicyService {
  if (!sharedService) {
    sharedService = new RbacPolicyService();
  }
  return sharedService;
}

/** Test-only: drop the singleton so a fresh profile/home can be exercised. */
export function resetRbacPolicyServiceForTests(): void {
  sharedService = null;
}

export function isBuiltInRoleId(roleId: string): boolean {
  return (Object.values(RBAC_BUILT_IN_ROLE_IDS) as string[]).includes(roleId);
}

export function sameSubject(a: RbacSubject, b: RbacSubject): boolean {
  if (a.platform !== b.platform || a.kind !== b.kind) return false;
  if (a.kind === "actor" && b.kind === "actor") {
    return a.actorId === b.actorId;
  }
  if (a.kind === "bucket" && b.kind === "bucket") {
    return a.bucket === b.bucket && (a.scopeId ?? null) === (b.scopeId ?? null);
  }
  return false;
}

function structuredClonePolicy(policy: RbacPolicy): RbacPolicy {
  return {
    policyVersion: policy.policyVersion,
    enforced: policy.enforced,
    roles: policy.roles.map((role) => ({
      ...role,
      permissions: [...role.permissions],
    })),
    attachments: policy.attachments.map((attachment) => ({
      subject: { ...attachment.subject },
      roleIds: [...attachment.roleIds],
      ...(attachment.displayName ? { displayName: attachment.displayName } : {}),
    })),
  };
}
