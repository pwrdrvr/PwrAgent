import { describe, expect, it } from "vitest";

import {
  ALL_MESSAGING_PERMISSIONS,
  BUILT_IN_ROLES,
  MESSAGING_PERMISSION_CATALOG,
  RBAC_BUILT_IN_ROLE_IDS,
  STATUS_ACTION_PERMISSIONS,
  emptyRbacPolicy,
  permissionForActionId,
  permissionForCommandVerb,
  permissionForDynamicTool,
  permissionsForThreadMutation,
  resolveEffectivePermissions,
  toolArgsTargetRemoteInstance,
  roleIsDangerous,
  type MessagingPermissionId,
  type RbacAttachment,
  type RbacRoleDefinition,
} from "../rbac";

function roleById(id: string): RbacRoleDefinition {
  const role = BUILT_IN_ROLES.find((r) => r.id === id);
  if (!role) throw new Error(`missing built-in role ${id}`);
  return role;
}

const ROLES = BUILT_IN_ROLES;

describe("rbac permission catalog", () => {
  it("catalog and permission-id list stay in sync", () => {
    expect(ALL_MESSAGING_PERMISSIONS).toEqual(
      MESSAGING_PERMISSION_CATALOG.map((d) => d.id),
    );
    // No duplicate ids.
    expect(new Set(ALL_MESSAGING_PERMISSIONS).size).toBe(
      ALL_MESSAGING_PERMISSIONS.length,
    );
  });

  it("marks Codex full access as high danger", () => {
    const fullAccess = MESSAGING_PERMISSION_CATALOG.find(
      (d) => d.id === "thread.execution.full_access",
    );
    expect(fullAccess?.danger).toBe("high");
  });
});

describe("built-in roles", () => {
  it("Admin holds every catalog permission (computed, never drifts)", () => {
    const admin = roleById(RBAC_BUILT_IN_ROLE_IDS.admin);
    expect(new Set(admin.permissions)).toEqual(new Set(ALL_MESSAGING_PERMISSIONS));
    expect(roleIsDangerous(admin.permissions)).toBe(true);
  });

  it("Power User lacks full access, escalation approvals, and agent tools", () => {
    const power = roleById(RBAC_BUILT_IN_ROLE_IDS.powerUser);
    expect(power.permissions).not.toContain("thread.execution.full_access");
    expect(power.permissions).not.toContain("approval.respond.escalation");
    expect(power.permissions).not.toContain("tools.thread_inspection");
    expect(power.permissions).not.toContain("tools.thread_orchestration");
    expect(power.permissions).not.toContain("tools.instance_management");
    expect(power.permissions).toContain("approval.respond.default");
    expect(power.permissions).toContain("thread.resume");
    expect(power.permissions).toContain("thread.settings.execution_mode");
    expect(roleIsDangerous(power.permissions)).toBe(false);
  });

  it("Power User + Tools is Power User plus the three agent-tool permissions", () => {
    const power = new Set(roleById(RBAC_BUILT_IN_ROLE_IDS.powerUser).permissions);
    const plus = roleById(RBAC_BUILT_IN_ROLE_IDS.powerUserTools);
    for (const perm of power) expect(plus.permissions).toContain(perm);
    expect(plus.permissions).toContain("tools.thread_inspection");
    expect(plus.permissions).toContain("tools.thread_orchestration");
    expect(plus.permissions).toContain("tools.instance_management");
    // Still not full-access or escalation-approval.
    expect(plus.permissions).not.toContain("thread.execution.full_access");
    expect(plus.permissions).not.toContain("approval.respond.escalation");
  });

  it("Chat User can view+reply+answer but not resume/detach/settings", () => {
    const chat = roleById(RBAC_BUILT_IN_ROLE_IDS.chatUser);
    expect(new Set(chat.permissions)).toEqual(
      new Set<MessagingPermissionId>([
        "message.reply",
        "elicitation.answer",
        "thread.status.view",
      ]),
    );
  });

  it("Limited Chat User is reply + answer only", () => {
    const limited = roleById(RBAC_BUILT_IN_ROLE_IDS.limitedChatUser);
    expect(new Set(limited.permissions)).toEqual(
      new Set<MessagingPermissionId>(["message.reply", "elicitation.answer"]),
    );
  });

  it("nests as a strict superset chain Admin ⊇ Power ⊇ Chat ⊇ Limited", () => {
    const sets = [
      RBAC_BUILT_IN_ROLE_IDS.admin,
      RBAC_BUILT_IN_ROLE_IDS.powerUser,
      RBAC_BUILT_IN_ROLE_IDS.chatUser,
      RBAC_BUILT_IN_ROLE_IDS.limitedChatUser,
    ].map((id) => new Set(roleById(id).permissions));
    for (let i = 0; i < sets.length - 1; i++) {
      const bigger = sets[i];
      const smaller = sets[i + 1];
      for (const p of smaller) {
        expect(bigger.has(p)).toBe(true);
      }
    }
  });
});

describe("resolveEffectivePermissions", () => {
  it("default-denies an actor with no matching attachment", () => {
    const result = resolveEffectivePermissions({
      platform: "slack",
      actorId: "U404",
      roles: ROLES,
      attachments: [],
    });
    expect(result.rejected).toBe(true);
    expect(result.permissions.size).toBe(0);
    expect(result.roleIds).toEqual([]);
    expect(result.matchedSubjects).toEqual([]);
  });

  it("grants the union of two roles (additive, order-independent)", () => {
    const custom: RbacRoleDefinition = {
      id: "role_extra",
      name: "Extra",
      builtIn: false,
      permissions: ["thread.detach"],
    };
    const attachments: RbacAttachment[] = [
      {
        subject: { kind: "actor", platform: "slack", actorId: "U1" },
        roleIds: [RBAC_BUILT_IN_ROLE_IDS.chatUser, "role_extra"],
      },
    ];
    const result = resolveEffectivePermissions({
      platform: "slack",
      actorId: "U1",
      roles: [...ROLES, custom],
      attachments,
    });
    expect(result.rejected).toBe(false);
    expect(result.permissions.has("message.reply")).toBe(true); // from chat_user
    expect(result.permissions.has("thread.detach")).toBe(true); // from role_extra
    expect(new Set(result.roleIds)).toEqual(
      new Set([RBAC_BUILT_IN_ROLE_IDS.chatUser, "role_extra"]),
    );
  });

  it("ignores attachments on a different platform", () => {
    const attachments: RbacAttachment[] = [
      {
        subject: { kind: "actor", platform: "telegram", actorId: "U1" },
        roleIds: [RBAC_BUILT_IN_ROLE_IDS.admin],
      },
    ];
    const result = resolveEffectivePermissions({
      platform: "slack",
      actorId: "U1",
      roles: ROLES,
      attachments,
    });
    expect(result.rejected).toBe(true);
  });

  it("skips unknown role ids without throwing", () => {
    const attachments: RbacAttachment[] = [
      {
        subject: { kind: "actor", platform: "slack", actorId: "U1" },
        roleIds: ["does_not_exist"],
      },
    ];
    const result = resolveEffectivePermissions({
      platform: "slack",
      actorId: "U1",
      roles: ROLES,
      attachments,
    });
    expect(result.rejected).toBe(true);
    expect(result.matchedSubjects).toHaveLength(1); // subject matched…
    expect(result.permissions.size).toBe(0); // …but granted nothing
  });

  describe("bucket composition", () => {
    const channelBucket: RbacAttachment = {
      subject: { kind: "bucket", platform: "slack", bucket: "channel_any_user" },
      roleIds: [RBAC_BUILT_IN_ROLE_IDS.chatUser],
    };

    it("matches a channel bucket only when admitted via that path", () => {
      const admitted = resolveEffectivePermissions({
        platform: "slack",
        actorId: "U999",
        conversationId: "C1",
        admittedVia: { channelBucket: true },
        roles: ROLES,
        attachments: [channelBucket],
      });
      expect(admitted.rejected).toBe(false);
      expect(admitted.permissions.has("message.reply")).toBe(true);
      expect(admitted.permissions.has("thread.resume")).toBe(false);

      const notViaBucket = resolveEffectivePermissions({
        platform: "slack",
        actorId: "U999",
        conversationId: "C1",
        admittedVia: { channelBucket: false },
        roles: ROLES,
        attachments: [channelBucket],
      });
      expect(notViaBucket.rejected).toBe(true);
    });

    it("unions a named-actor role with a matching bucket role", () => {
      const named: RbacAttachment = {
        subject: { kind: "actor", platform: "slack", actorId: "U999" },
        roleIds: ["role_detach"],
      };
      const custom: RbacRoleDefinition = {
        id: "role_detach",
        name: "Detacher",
        builtIn: false,
        permissions: ["thread.detach"],
      };
      const result = resolveEffectivePermissions({
        platform: "slack",
        actorId: "U999",
        conversationId: "C1",
        admittedVia: { channelBucket: true },
        roles: [...ROLES, custom],
        attachments: [named, channelBucket],
      });
      expect(result.permissions.has("thread.detach")).toBe(true); // named
      expect(result.permissions.has("message.reply")).toBe(true); // bucket
      expect(result.matchedSubjects).toHaveLength(2);
    });

    it("narrows a scoped channel bucket to one conversation", () => {
      const scoped: RbacAttachment = {
        subject: {
          kind: "bucket",
          platform: "slack",
          bucket: "channel_any_user",
          scopeId: "C1",
        },
        roleIds: [RBAC_BUILT_IN_ROLE_IDS.chatUser],
      };
      const inScope = resolveEffectivePermissions({
        platform: "slack",
        actorId: "U999",
        conversationId: "C1",
        admittedVia: { channelBucket: true },
        roles: ROLES,
        attachments: [scoped],
      });
      expect(inScope.rejected).toBe(false);

      const outOfScope = resolveEffectivePermissions({
        platform: "slack",
        actorId: "U999",
        conversationId: "C2",
        admittedVia: { channelBucket: true },
        roles: ROLES,
        attachments: [scoped],
      });
      expect(outOfScope.rejected).toBe(true);
    });

    it("matches a DM workspace bucket only when admitted via the DM path", () => {
      const dmBucket: RbacAttachment = {
        subject: {
          kind: "bucket",
          platform: "slack",
          bucket: "dm_any_workspace_user",
        },
        roleIds: [RBAC_BUILT_IN_ROLE_IDS.limitedChatUser],
      };
      const admitted = resolveEffectivePermissions({
        platform: "slack",
        actorId: "U777",
        admittedVia: { dmBucket: true },
        roles: ROLES,
        attachments: [dmBucket],
      });
      expect(admitted.permissions.has("message.reply")).toBe(true);
      expect(admitted.permissions.has("thread.status.view")).toBe(false);

      const notDm = resolveEffectivePermissions({
        platform: "slack",
        actorId: "U777",
        admittedVia: { channelBucket: true },
        roles: ROLES,
        attachments: [dmBucket],
      });
      expect(notDm.rejected).toBe(true);
    });
  });
});

describe("action → permission lookup tables", () => {
  it("maps command verbs, leaving help ungated", () => {
    expect(permissionForCommandVerb("resume")).toBe("thread.resume");
    expect(permissionForCommandVerb("agent")).toBe("thread.resume");
    expect(permissionForCommandVerb("new")).toBe("thread.new");
    expect(permissionForCommandVerb("status")).toBe("thread.status.view");
    expect(permissionForCommandVerb("detach")).toBe("thread.detach");
    expect(permissionForCommandVerb("monitor")).toBe("thread.monitor");
    expect(permissionForCommandVerb("help")).toBeUndefined();
  });

  it("maps every status action to a real catalog permission", () => {
    for (const [actionId, permission] of Object.entries(
      STATUS_ACTION_PERMISSIONS,
    )) {
      expect(ALL_MESSAGING_PERMISSIONS).toContain(permission);
      expect(permissionForActionId(actionId)).toBe(permission);
    }
  });

  it("maps dynamic tool categories to the right agent-tool permission", () => {
    // thread_inspection is read-only.
    expect(permissionForDynamicTool("thread_inspection", "search_threads")).toBe(
      "tools.thread_inspection",
    );
    expect(permissionForDynamicTool("thread_inspection", "read_thread")).toBe(
      "tools.thread_inspection",
    );
    // The two writes shipped in that catalog are re-homed.
    expect(
      permissionForDynamicTool("thread_inspection", "mutate_thread"),
    ).toBeUndefined(); // gated per-field instead
    expect(
      permissionForDynamicTool("thread_inspection", "attach_thread_pull_request"),
    ).toBe("tools.thread_orchestration");
    expect(
      permissionForDynamicTool("thread_orchestration", "send_message_to_thread"),
    ).toBe("tools.thread_orchestration");
    expect(permissionForDynamicTool("app_management", "manage_pwragent")).toBe(
      "tools.instance_management",
    );
    expect(
      permissionForDynamicTool("automation_inspection", "list_automations"),
    ).toBe("tools.instance_management");
    // messaging_context: benign surface ungated; file send is a message;
    // attach binds → resume.
    expect(
      permissionForDynamicTool("messaging_context", "get_current_messaging_surface"),
    ).toBeUndefined();
    expect(
      permissionForDynamicTool("messaging_context", "send_private_response"),
    ).toBeUndefined();
    expect(
      permissionForDynamicTool("messaging_context", "send_messaging_file"),
    ).toBe("message.reply");
    expect(
      permissionForDynamicTool("messaging_context", "attach_thread_here"),
    ).toBe("thread.resume");
  });

  it("gates mutate_thread per field, at parity with the status buttons", () => {
    expect(permissionsForThreadMutation(null)).toEqual([]);
    expect(permissionsForThreadMutation({ dryRun: true } as never)).toEqual([]);
    expect(permissionsForThreadMutation({ title: "x" })).toEqual([
      "thread.settings.name",
    ]);
    expect(new Set(permissionsForThreadMutation({ model: "m", reasoningEffort: "high" }))).toEqual(
      new Set(["thread.settings.model", "thread.settings.reasoning"]),
    );
    expect(permissionsForThreadMutation({ fastMode: true })).toEqual([
      "thread.settings.fast_mode",
    ]);
    // Non-full-access execution mode needs only the settings permission.
    expect(permissionsForThreadMutation({ executionMode: "default" })).toEqual([
      "thread.settings.execution_mode",
    ]);
    // Escalating to full access double-gates on the danger permission.
    expect(
      new Set(permissionsForThreadMutation({ executionMode: "full-access" })),
    ).toEqual(
      new Set(["thread.settings.execution_mode", "thread.execution.full_access"]),
    );
  });

  it("resolves prefixed action ids for render-time filtering", () => {
    expect(permissionForActionId("command:resume")).toBe("thread.resume");
    expect(permissionForActionId("handoff:confirm")).toBe(
      "thread.control.handoff",
    );
    expect(permissionForActionId("questionnaire:submit")).toBe(
      "elicitation.answer",
    );
    // Every skills sub-action is gated like the status:skills entry button.
    expect(permissionForActionId("skills:select")).toBe("thread.settings.skills");
    expect(permissionForActionId("skills:remove")).toBe("thread.settings.skills");
    expect(permissionForActionId("skills:next")).toBe("thread.settings.skills");
    // Ungated chrome resolves to undefined (rendered for everyone).
    expect(permissionForActionId("help:cancel")).toBeUndefined();
    expect(permissionForActionId("command:help")).toBeUndefined();
  });
});

describe("federation scope", () => {
  it("is not granted by any built-in except Admin", () => {
    for (const role of BUILT_IN_ROLES) {
      const holds = role.permissions.includes("federation.remote_control");
      expect(
        holds,
        `${role.id} should ${role.id === RBAC_BUILT_IN_ROLE_IDS.admin ? "" : "not "}reach other instances`,
      ).toBe(role.id === RBAC_BUILT_IN_ROLE_IDS.admin);
    }
  });

  it("detects explicit remote targeting in tool args", () => {
    expect(toolArgsTargetRemoteInstance({ instanceId: "peer-1" })).toBe(true);
    expect(toolArgsTargetRemoteInstance({ includeRemote: true })).toBe(true);
    // Local-only and unspecified calls are not *explicit* remote targeting.
    expect(toolArgsTargetRemoteInstance({ includeRemote: false })).toBe(false);
    expect(toolArgsTargetRemoteInstance({ threadId: "t1" })).toBe(false);
    expect(toolArgsTargetRemoteInstance({ instanceId: "  " })).toBe(false);
    expect(toolArgsTargetRemoteInstance(null)).toBe(false);
  });

  it("is orthogonal — it grants no thread capability on its own", () => {
    const scopeOnly: RbacRoleDefinition = {
      id: "role_scope",
      name: "Scope only",
      builtIn: false,
      permissions: ["federation.remote_control"],
    };
    const resolution = resolveEffectivePermissions({
      platform: "slack",
      actorId: "U1",
      roles: [scopeOnly],
      attachments: [
        {
          subject: { kind: "actor", platform: "slack", actorId: "U1" },
          roleIds: ["role_scope"],
        },
      ],
    });
    expect(resolution.permissions.has("federation.remote_control")).toBe(true);
    expect(resolution.permissions.has("message.reply")).toBe(false);
    expect(resolution.permissions.has("thread.resume")).toBe(false);
  });
});

describe("policy defaults", () => {
  it("starts unenforced and empty", () => {
    const policy = emptyRbacPolicy();
    expect(policy.enforced).toBe(false);
    expect(policy.roles).toEqual([]);
    expect(policy.attachments).toEqual([]);
  });
});
