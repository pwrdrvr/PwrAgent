import type { MessagingChannelKind } from "./messaging";

/**
 * Additive RBAC for messaging-platform actors (issue #260).
 *
 * This module is the single source of truth for the permission catalog, the
 * built-in role definitions, and the pure permission-resolution engine. It
 * lives in `@pwragent/shared` so BOTH the desktop main process (which enforces
 * per-action capability checks) and the renderer (which draws the Access
 * Control graph) import ONE implementation without a dependency-boundary
 * violation — shared is the leaf everyone may depend on.
 *
 * The model, in one paragraph: permissions are atomic capability IDs; roles
 * bundle them; actors and buckets attach to roles per messaging platform. An
 * actor's effective permissions are the UNION of every role reachable from
 * every attachment that matches. There are no deny rules (strictly additive,
 * AWS-IAM style). An actor that matches no permission-granting role is
 * default-denied.
 *
 * RBAC is a SECOND authorization layer that composes with — and never replaces
 * — the provider admission gate (e.g. Slack's `authorizeInbound`). The provider
 * gate answers "may this actor reach the bot at all"; RBAC answers "what may an
 * admitted actor do".
 */

// ---------------------------------------------------------------------------
// Permission catalog
// ---------------------------------------------------------------------------

/**
 * Stable atomic capability IDs. These are contractually load-bearing: once
 * shipped, a permission ID must not change meaning, because it is persisted in
 * custom role definitions in `config.toml`. Add new IDs; never repurpose old
 * ones.
 */
export type MessagingPermissionId =
  // Baseline conversational — the floor a Limited Chat User keeps.
  | "message.reply"
  | "elicitation.answer"
  // Session / thread control.
  | "thread.status.view"
  | "thread.resume"
  | "thread.new"
  | "thread.detach"
  | "thread.monitor"
  // Per-thread settings mutations (non-full-access).
  | "thread.settings.model"
  | "thread.settings.reasoning"
  | "thread.settings.fast_mode"
  | "thread.settings.tool_updates"
  | "thread.settings.streaming"
  | "thread.settings.permissions_mode"
  | "thread.settings.execution_mode"
  | "thread.settings.name"
  | "thread.settings.skills"
  // Turn control.
  | "thread.control.stop"
  | "thread.control.compact"
  | "thread.control.handoff"
  // Mid-turn interactive surfaces.
  | "approval.respond.default"
  | "approval.respond.escalation"
  // Escalation-equivalent — near-complete control of the host. Danger.
  | "thread.execution.full_access";

export type MessagingPermissionDanger = "med" | "high";

export type MessagingPermissionGroup =
  | "conversation"
  | "session"
  | "settings"
  | "control"
  | "interactive"
  | "danger";

export type MessagingPermissionDescriptor = {
  id: MessagingPermissionId;
  /** Short human label for the Access Control UI. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  group: MessagingPermissionGroup;
  danger?: MessagingPermissionDanger;
};

/**
 * The full permission catalog, in display order. Drives the permissions column
 * of the Access Control graph and the drift-guard test. Keep in sync with
 * `MessagingPermissionId`.
 */
export const MESSAGING_PERMISSION_CATALOG: readonly MessagingPermissionDescriptor[] = [
  {
    id: "message.reply",
    label: "Reply to the agent",
    description: "Send a plain message turn to a bound thread.",
    group: "conversation",
  },
  {
    id: "elicitation.answer",
    label: "Answer questions",
    description: "Respond to the agent's elicitation prompts.",
    group: "conversation",
  },
  {
    id: "thread.status.view",
    label: "View thread status",
    description: "Read the binding status card and transcript.",
    group: "session",
  },
  {
    id: "thread.resume",
    label: "Resume a thread",
    description: "Attach this conversation to an existing thread.",
    group: "session",
  },
  {
    id: "thread.new",
    label: "Start a new thread",
    description: "Open a new thread from a project.",
    group: "session",
  },
  {
    id: "thread.detach",
    label: "Detach a thread",
    description: "Unbind this conversation from its thread.",
    group: "session",
  },
  {
    id: "thread.monitor",
    label: "Monitor threads",
    description: "Watch recent threads once per minute.",
    group: "session",
  },
  {
    id: "thread.settings.model",
    label: "Change model",
    description: "Set the thread's model.",
    group: "settings",
  },
  {
    id: "thread.settings.reasoning",
    label: "Change reasoning effort",
    description: "Set the thread's reasoning effort.",
    group: "settings",
  },
  {
    id: "thread.settings.fast_mode",
    label: "Toggle fast mode",
    description: "Trade quality for speed on the thread.",
    group: "settings",
  },
  {
    id: "thread.settings.tool_updates",
    label: "Change tool-update mode",
    description: "Set how tool activity streams.",
    group: "settings",
  },
  {
    id: "thread.settings.streaming",
    label: "Change streaming mode",
    description: "Set how responses stream.",
    group: "settings",
  },
  {
    id: "thread.settings.permissions_mode",
    label: "Change permissions mode",
    description: "Switch the sandbox/default permissions mode (non-full-access).",
    group: "settings",
  },
  {
    id: "thread.settings.execution_mode",
    label: "Change execution mode",
    description: "Switch the sandbox/network execution mode (non-full-access).",
    group: "settings",
  },
  {
    id: "thread.settings.name",
    label: "Rename thread",
    description: "Sync the thread name to the conversation.",
    group: "settings",
  },
  {
    id: "thread.settings.skills",
    label: "Manage skills",
    description: "Change the thread's enabled skills.",
    group: "settings",
  },
  {
    id: "thread.control.stop",
    label: "Stop a turn",
    description: "Interrupt the running turn.",
    group: "control",
  },
  {
    id: "thread.control.compact",
    label: "Compact a thread",
    description: "Compact the thread's context.",
    group: "control",
  },
  {
    id: "thread.control.handoff",
    label: "Hand off a thread",
    description: "Move a thread between local/worktree/branches.",
    group: "control",
  },
  {
    id: "approval.respond.default",
    label: "Respond to approvals",
    description: "Approve or deny non-escalation approval requests.",
    group: "interactive",
  },
  {
    id: "approval.respond.escalation",
    label: "Respond to escalations",
    description: "Approve or deny network / exec / filesystem escalations.",
    group: "interactive",
    danger: "med",
  },
  {
    id: "thread.execution.full_access",
    label: "Codex Full Access",
    description:
      "Select or resume into full-access execution — near-complete control of the host.",
    group: "danger",
    danger: "high",
  },
];

/** Every permission ID, in catalog order. */
export const ALL_MESSAGING_PERMISSIONS: readonly MessagingPermissionId[] =
  MESSAGING_PERMISSION_CATALOG.map((descriptor) => descriptor.id);

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type RbacRoleDefinition = {
  /** Stable ID. Built-in IDs are reserved; custom roles must not reuse them. */
  id: string;
  name: string;
  description?: string;
  /** Built-in roles are code constants, never persisted. */
  builtIn: boolean;
  /** True when the role includes an escalation-equivalent permission. */
  danger?: boolean;
  permissions: MessagingPermissionId[];
};

/** Reserved built-in role IDs. */
export const RBAC_BUILT_IN_ROLE_IDS = {
  admin: "admin",
  powerUser: "power_user",
  chatUser: "chat_user",
  limitedChatUser: "limited_chat_user",
} as const;

/**
 * Whether a role's permission set makes it escalation-equivalent. A role that
 * can select full access is dangerous and must carry the danger marker (drives
 * the danger badge + the mandatory two-factor grant acknowledgment).
 */
export function roleIsDangerous(
  permissions: readonly MessagingPermissionId[],
): boolean {
  return permissions.includes("thread.execution.full_access");
}

/**
 * Power User: everything a thread operator needs EXCEPT approving escalations
 * and selecting full access. Enumerated explicitly (not computed) so a newly
 * added permission is opt-in for Power User rather than silently granted.
 */
const POWER_USER_PERMISSIONS: MessagingPermissionId[] = [
  "message.reply",
  "elicitation.answer",
  "thread.status.view",
  "thread.resume",
  "thread.new",
  "thread.detach",
  "thread.monitor",
  "thread.settings.model",
  "thread.settings.reasoning",
  "thread.settings.fast_mode",
  "thread.settings.tool_updates",
  "thread.settings.streaming",
  "thread.settings.permissions_mode",
  "thread.settings.execution_mode",
  "thread.settings.name",
  "thread.settings.skills",
  "thread.control.stop",
  "thread.control.compact",
  "thread.control.handoff",
  "approval.respond.default",
];

const CHAT_USER_PERMISSIONS: MessagingPermissionId[] = [
  "message.reply",
  "elicitation.answer",
  "thread.status.view",
];

const LIMITED_CHAT_USER_PERMISSIONS: MessagingPermissionId[] = [
  "message.reply",
  "elicitation.answer",
];

/**
 * Built-in roles. Admin is computed as the WHOLE catalog so it never silently
 * loses a newly added capability; the others are explicit lists so new
 * permissions are opt-in for them.
 */
export const BUILT_IN_ROLES: readonly RbacRoleDefinition[] = [
  {
    id: RBAC_BUILT_IN_ROLE_IDS.admin,
    name: "Admin",
    description: "Full capability, including Codex Full Access.",
    builtIn: true,
    danger: true,
    permissions: [...ALL_MESSAGING_PERMISSIONS],
  },
  {
    id: RBAC_BUILT_IN_ROLE_IDS.powerUser,
    name: "Power User",
    description:
      "Start, resume, and control threads and their settings. No full access, no escalation approvals.",
    builtIn: true,
    permissions: POWER_USER_PERMISSIONS,
  },
  {
    id: RBAC_BUILT_IN_ROLE_IDS.chatUser,
    name: "Chat User",
    description: "Chat with mounted threads and answer questions. Read-only otherwise.",
    builtIn: true,
    permissions: CHAT_USER_PERMISSIONS,
  },
  {
    id: RBAC_BUILT_IN_ROLE_IDS.limitedChatUser,
    name: "Limited Chat User",
    description: "Reply and answer questions only. No control buttons.",
    builtIn: true,
    permissions: LIMITED_CHAT_USER_PERMISSIONS,
  },
];

// ---------------------------------------------------------------------------
// Subjects + attachments
// ---------------------------------------------------------------------------

/**
 * A bucket subject represents a whole set of admitted-but-unnamed actors that a
 * Slack access mode lets in:
 *   - `channel_any_user`     → `channelUserAccessMode: "any_channel_user"`
 *   - `dm_any_workspace_user`→ `dmAccessMode: "any_workspace_user"`
 */
export type RbacBucketKind = "channel_any_user" | "dm_any_workspace_user";

export type RbacSubject =
  | { kind: "actor"; platform: MessagingChannelKind; actorId: string }
  | {
      kind: "bucket";
      platform: MessagingChannelKind;
      bucket: RbacBucketKind;
      /** Optional: narrow a channel bucket to a single conversation id. */
      scopeId?: string;
    };

/** One subject → roles edge. Additive: a subject may hold several roles. */
export type RbacAttachment = {
  subject: RbacSubject;
  roleIds: string[];
  /**
   * Optional friendly label for the UI (e.g. the actor's display name at the
   * time the attachment was made). Not load-bearing for resolution.
   */
  displayName?: string;
};

// ---------------------------------------------------------------------------
// Resolution engine (pure)
// ---------------------------------------------------------------------------

/**
 * Which bucket admission path (if any) admitted this actor. The desktop
 * controller derives this from the provider gate outcome so the resolver knows
 * whether a bucket attachment is eligible to match.
 */
export type RbacAdmittedVia = {
  channelBucket?: boolean;
  dmBucket?: boolean;
};

export type RbacResolveInput = {
  platform: MessagingChannelKind;
  actorId: string;
  conversationId?: string;
  admittedVia?: RbacAdmittedVia;
  /** Built-in ∪ custom roles, resolved by the caller. */
  roles: readonly RbacRoleDefinition[];
  attachments: readonly RbacAttachment[];
};

export type RbacResolution = {
  permissions: Set<MessagingPermissionId>;
  /** Distinct role IDs that matched and resolved to a definition. */
  roleIds: string[];
  /** The subjects (named actor and/or buckets) that matched. */
  matchedSubjects: RbacSubject[];
  /** True when no permission is granted — default-deny. */
  rejected: boolean;
};

function subjectMatches(
  subject: RbacSubject,
  input: RbacResolveInput,
): boolean {
  if (subject.platform !== input.platform) {
    return false;
  }
  if (subject.kind === "actor") {
    return subject.actorId === input.actorId;
  }
  // Bucket: only eligible when the actor was actually admitted via that path.
  if (subject.bucket === "channel_any_user") {
    if (!input.admittedVia?.channelBucket) {
      return false;
    }
    if (subject.scopeId !== undefined) {
      return subject.scopeId === input.conversationId;
    }
    return true;
  }
  if (subject.bucket === "dm_any_workspace_user") {
    return Boolean(input.admittedVia?.dmBucket);
  }
  return false;
}

/**
 * Resolve an actor's effective permissions. Pure — no I/O, no clock, no
 * randomness. The union of every role reachable from every matching subject.
 * Default-deny: an actor matching no permission-granting role gets an empty set
 * and `rejected: true`.
 */
export function resolveEffectivePermissions(
  input: RbacResolveInput,
): RbacResolution {
  const roleById = new Map<string, RbacRoleDefinition>();
  for (const role of input.roles) {
    roleById.set(role.id, role);
  }

  const permissions = new Set<MessagingPermissionId>();
  const matchedRoleIds = new Set<string>();
  const matchedSubjects: RbacSubject[] = [];

  for (const attachment of input.attachments) {
    if (!subjectMatches(attachment.subject, input)) {
      continue;
    }
    matchedSubjects.push(attachment.subject);
    for (const roleId of attachment.roleIds) {
      const role = roleById.get(roleId);
      if (!role) {
        continue;
      }
      matchedRoleIds.add(role.id);
      for (const permission of role.permissions) {
        permissions.add(permission);
      }
    }
  }

  return {
    permissions,
    roleIds: [...matchedRoleIds],
    matchedSubjects,
    rejected: permissions.size === 0,
  };
}

// ---------------------------------------------------------------------------
// Action → permission lookup tables (shared by enforcement + render-time
// filtering so the two can never drift).
// ---------------------------------------------------------------------------

/**
 * Command verb → required permission. `help` is intentionally absent (ungated:
 * it only explains the command surface and helps a user understand what they
 * lack). `agent` shares the `resume` permission — it is the agent-thread
 * variant of the same browse-and-bind capability.
 *
 * Keyed by plain string (not the desktop `MessagingCommandVerb` union) so this
 * leaf module stays free of any desktop dependency; the desktop verb union is a
 * string subtype, so call sites still type-check. The drift-guard test lives in
 * the desktop package, which can import the real catalog and assert coverage.
 */
const COMMAND_VERB_PERMISSIONS: Record<string, MessagingPermissionId> = {
  resume: "thread.resume",
  agent: "thread.resume",
  new: "thread.new",
  status: "thread.status.view",
  detach: "thread.detach",
  monitor: "thread.monitor",
};

export function permissionForCommandVerb(
  verb: string,
): MessagingPermissionId | undefined {
  return COMMAND_VERB_PERMISSIONS[verb];
}

/**
 * Status-card / handoff / questionnaire action id → required permission.
 *
 * Every `status:*` and `handoff:*` action a binding status card can render is
 * mapped here. The full-access nuance for `status:set-permissions` /
 * `status:set-runtime-mode` (requiring `thread.execution.full_access` when the
 * TARGET is full-access) is handled at the enforcement call site, not here —
 * this table returns the baseline settings permission.
 *
 * Approval actions are deliberately NOT in this table: they split between
 * `approval.respond.default` and `approval.respond.escalation` based on the
 * pending request, so the controller resolves them explicitly.
 */
export const STATUS_ACTION_PERMISSIONS: Record<string, MessagingPermissionId> = {
  "status:refresh": "thread.status.view",
  "status:model": "thread.settings.model",
  "status:set-model": "thread.settings.model",
  "status:reasoning": "thread.settings.reasoning",
  "status:set-reasoning": "thread.settings.reasoning",
  "status:fast": "thread.settings.fast_mode",
  "status:tool-updates": "thread.settings.tool_updates",
  "status:set-tool-updates": "thread.settings.tool_updates",
  "status:streaming": "thread.settings.streaming",
  "status:permissions": "thread.settings.permissions_mode",
  "status:set-permissions": "thread.settings.permissions_mode",
  "status:runtime-mode": "thread.settings.execution_mode",
  "status:set-runtime-mode": "thread.settings.execution_mode",
  "status:sync-name": "thread.settings.name",
  "status:skills": "thread.settings.skills",
  "status:detach": "thread.detach",
  "status:compact": "thread.control.compact",
  "status:stop": "thread.control.stop",
  "status:handoff": "thread.control.handoff",
};

/**
 * Resolve any button/callback action id to its required permission for
 * render-time filtering. Returns `undefined` for actions that are ungated here
 * (help/cancel/nav) or handled specially (approvals). Prefix rules:
 *   - `command:<verb>` → command table
 *   - `status:*`       → status table
 *   - `handoff:*`      → `thread.control.handoff`
 *   - `questionnaire:*`→ `elicitation.answer`
 */
export function permissionForActionId(
  actionId: string,
): MessagingPermissionId | undefined {
  if (actionId.startsWith("command:")) {
    return permissionForCommandVerb(actionId.slice("command:".length));
  }
  if (actionId.startsWith("handoff:")) {
    return "thread.control.handoff";
  }
  if (actionId.startsWith("questionnaire:")) {
    return "elicitation.answer";
  }
  return STATUS_ACTION_PERMISSIONS[actionId];
}

// ---------------------------------------------------------------------------
// Persisted policy shape + IPC contracts
// ---------------------------------------------------------------------------

/**
 * The RBAC policy as persisted per-profile (custom roles + attachments only;
 * built-in roles are code constants). `enforced` gates the whole system: when
 * false (or when the policy is absent entirely), the controller runs in
 * legacy-compatible mode where every admitted actor is implicitly Admin.
 */
export type RbacPolicy = {
  policyVersion: number;
  enforced: boolean;
  /** Custom roles only. */
  roles: RbacRoleDefinition[];
  attachments: RbacAttachment[];
};

export const RBAC_POLICY_VERSION = 1;

export function emptyRbacPolicy(): RbacPolicy {
  return {
    policyVersion: RBAC_POLICY_VERSION,
    enforced: false,
    roles: [],
    attachments: [],
  };
}

/** Read the full policy (built-in ∪ custom roles + attachments + catalog). */
export type ReadRbacPolicyResponse = {
  enforced: boolean;
  /** Built-in roles first, then custom. */
  roles: RbacRoleDefinition[];
  attachments: RbacAttachment[];
  permissionCatalog: readonly MessagingPermissionDescriptor[];
};

export type WriteRbacRoleRequest = {
  role: RbacRoleDefinition;
  /**
   * Required when the role includes `thread.execution.full_access`: the
   * operator must type the confirmation phrase. Enforced main-side.
   */
  fullAccessAcknowledgment?: string;
};

export type WriteRbacRoleResponse = {
  ok: boolean;
  error?: string;
};

export type DeleteRbacRoleRequest = { roleId: string };
export type DeleteRbacRoleResponse = { ok: boolean; error?: string };

export type WriteRbacAttachmentRequest = {
  attachment: RbacAttachment;
};
export type WriteRbacAttachmentResponse = { ok: boolean; error?: string };

export type DeleteRbacAttachmentRequest = {
  subject: RbacSubject;
};
export type DeleteRbacAttachmentResponse = { ok: boolean; error?: string };

export type SetRbacEnforcedRequest = {
  enforced: boolean;
  /** When enabling for the first time, seed from these synthesized attachments. */
  synthesizedAttachments?: RbacAttachment[];
};
export type SetRbacEnforcedResponse = { ok: boolean; error?: string };

/**
 * A subject PwrAgent already knows about from its messaging config: every
 * authorized actor per platform, plus the wide bucket subjects that a Slack
 * access mode opens. Feeds the Actors column of the graph and the attachment
 * editor without the operator having to type IDs.
 */
export type RbacKnownSubject = {
  subject: RbacSubject;
  displayName?: string;
  /** True for the wide bucket subjects (any-channel-user / any-workspace DM). */
  bucket?: boolean;
};

export type ReadRbacKnownSubjectsResponse = {
  subjects: RbacKnownSubject[];
};

/** A fully-resolved edge for the visualizer: which subject reaches which permission via which role. */
export type RbacGraphEdge = {
  subject: RbacSubject;
  roleId: string;
  permission: MessagingPermissionId;
};

export type ResolveRbacGraphResponse = {
  edges: RbacGraphEdge[];
  /** Subjects that hold no permission-granting role (default-deny terminals). */
  rejectedSubjects: RbacSubject[];
};

/** The typed phrase an operator must enter to add full access to a custom role. */
export const RBAC_FULL_ACCESS_ACKNOWLEDGMENT_PHRASE =
  "I understand this gives the actor near-complete control of this machine";
