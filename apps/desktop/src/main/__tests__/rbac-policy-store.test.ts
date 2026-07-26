import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RBAC_BUILT_IN_ROLE_IDS,
  emptyRbacPolicy,
  type RbacPolicy,
} from "@pwragent/shared";

import {
  readRbacPolicy,
  resolveLegacyRbacPolicyJsonPath,
  resolveRbacConfigPath,
  writeRbacPolicy,
} from "../settings/rbac-policy-store";
import { RbacPolicyService } from "../messaging/rbac-policy-service";
import type { RecordMessagingActivityInput } from "../messaging/messaging-activity-log";

let tmpHome: string;
let storeOptions: { env: NodeJS.ProcessEnv };

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-rbac-"));
  storeOptions = { env: { PWRAGENT_HOME: tmpHome, PWRAGENT_PROFILE: "default" } };
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("rbac policy store", () => {
  it("returns an empty unenforced policy when no config exists", () => {
    const policy = readRbacPolicy(storeOptions);
    expect(policy).toEqual(emptyRbacPolicy());
  });

  it("round-trips a policy through config.toml", () => {
    const policy: RbacPolicy = {
      policyVersion: 1,
      enforced: true,
      roles: [
        {
          id: "role_oncall",
          name: "On-call",
          builtIn: false,
          permissions: ["message.reply", "thread.status.view"],
        },
      ],
      attachments: [
        {
          subject: { kind: "actor", platform: "slack", actorId: "U1" },
          roleIds: ["role_oncall"],
          displayName: "Alice",
        },
        {
          subject: {
            kind: "bucket",
            platform: "slack",
            bucket: "channel_any_user",
            scopeId: "C1",
          },
          roleIds: [RBAC_BUILT_IN_ROLE_IDS.chatUser],
        },
      ],
    };
    writeRbacPolicy(policy, storeOptions);
    const configPath = resolveRbacConfigPath(storeOptions);
    expect(fs.existsSync(configPath)).toBe(true);
    const source = fs.readFileSync(configPath, "utf8");
    expect(source).toContain("[messaging.rbac]");
    expect(source).toContain("[[messaging.rbac.roles]]");
    expect(source).toContain('permissions = ["message.reply", "thread.status.view"]');
    expect(readRbacPolicy(storeOptions)).toEqual(policy);
  });

  it("preserves unrelated config content and comments across writes", () => {
    const configPath = resolveRbacConfigPath(storeOptions);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        "# operator note: keep me",
        "[general]",
        'theme = "dark"',
        "",
        "[messaging.slack]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    writeRbacPolicy(
      {
        ...emptyRbacPolicy(),
        enforced: true,
        attachments: [
          {
            subject: { kind: "actor", platform: "slack", actorId: "U1" },
            roleIds: [RBAC_BUILT_IN_ROLE_IDS.admin],
          },
        ],
      },
      storeOptions,
    );
    const source = fs.readFileSync(configPath, "utf8");
    expect(source).toContain("# operator note: keep me");
    expect(source).toContain('theme = "dark"');
    expect(source).toContain("[messaging.slack]");
    expect(readRbacPolicy(storeOptions).enforced).toBe(true);
  });

  it("forces persisted roles to builtIn:false and drops malformed rows", () => {
    const configPath = resolveRbacConfigPath(storeOptions);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        "[messaging.rbac]",
        "enforced = true",
        "",
        "[[messaging.rbac.roles]]",
        'id = "ok"',
        'name = "OK"',
        'permissions = ["message.reply"]',
        "",
        "[[messaging.rbac.roles]]",
        'name = "no id"',
        "permissions = []",
        "",
        "[[messaging.rbac.attachments]]",
        'platform = "slack"',
        'subject_kind = "actor"',
        'actor_id = "U1"',
        'role_ids = ["ok"]',
        "",
        "[[messaging.rbac.attachments]]",
        'platform = "slack"',
        'subject_kind = "bogus"',
        'role_ids = ["ok"]',
        "",
      ].join("\n"),
    );
    const policy = readRbacPolicy(storeOptions);
    expect(policy.enforced).toBe(true);
    expect(policy.roles).toHaveLength(1);
    expect(policy.roles[0]).toMatchObject({ id: "ok", builtIn: false });
    expect(policy.attachments).toHaveLength(1);
  });

  it("fails CLOSED when malformed TOML still shows RBAC was configured", () => {
    const configPath = resolveRbacConfigPath(storeOptions);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "[messaging.rbac]\nenforced = true\n[broken");
    const policy = readRbacPolicy(storeOptions);
    expect(policy.enforced).toBe(true);
    expect(policy.roles).toHaveLength(0);
    expect(policy.attachments).toHaveLength(0);
  });

  it("fails open (unenforced) on malformed TOML with no RBAC data", () => {
    const configPath = resolveRbacConfigPath(storeOptions);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "[general\ntheme = ");
    expect(readRbacPolicy(storeOptions)).toEqual(emptyRbacPolicy());
  });

  it("fails CLOSED when the section exists but the enforced flag is garbled", () => {
    const configPath = resolveRbacConfigPath(storeOptions);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      '[messaging.rbac]\nenforced = "yes"\n',
    );
    expect(readRbacPolicy(storeOptions).enforced).toBe(true);
    // Only a clean `enforced = false` turns enforcement off.
    fs.writeFileSync(configPath, "[messaging.rbac]\nenforced = false\n");
    expect(readRbacPolicy(storeOptions).enforced).toBe(false);
  });

  it("fails CLOSED on an unparseable legacy JSON file", () => {
    const legacyPath = resolveLegacyRbacPolicyJsonPath(storeOptions);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, "{ not json");
    const policy = readRbacPolicy(storeOptions);
    expect(policy.enforced).toBe(true);
    expect(policy.attachments).toHaveLength(0);
  });

  it("falls back to the legacy JSON file and retires it on the next write", () => {
    const legacyPath = resolveLegacyRbacPolicyJsonPath(storeOptions);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        policyVersion: 1,
        enforced: true,
        roles: [
          { id: "ok", name: "OK", builtIn: true, permissions: ["message.reply"] },
        ],
        attachments: [
          {
            subject: { kind: "actor", platform: "slack", actorId: "U1" },
            roleIds: ["ok"],
          },
        ],
      }),
    );
    const fromLegacy = readRbacPolicy(storeOptions);
    expect(fromLegacy.enforced).toBe(true);
    expect(fromLegacy.roles[0]).toMatchObject({ id: "ok", builtIn: false });

    writeRbacPolicy(fromLegacy, storeOptions);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(`${legacyPath}.migrated`)).toBe(true);
    // The TOML section now wins outright.
    expect(readRbacPolicy(storeOptions)).toEqual(fromLegacy);
  });

  it("prefers an existing TOML section over a lingering legacy JSON file", () => {
    const legacyPath = resolveLegacyRbacPolicyJsonPath(storeOptions);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({ policyVersion: 1, enforced: true, roles: [], attachments: [] }),
    );
    writeRbacPolicy(emptyRbacPolicy(), storeOptions);
    expect(readRbacPolicy(storeOptions).enforced).toBe(false);
  });
});

describe("RbacPolicyService", () => {
  it("exposes built-in ∪ custom roles and starts unenforced", () => {
    const service = new RbacPolicyService(storeOptions);
    expect(service.isEnforcing()).toBe(false);
    const roleIds = service.allRoles().map((r) => r.id);
    expect(roleIds).toContain(RBAC_BUILT_IN_ROLE_IDS.admin);
    expect(roleIds).toContain(RBAC_BUILT_IN_ROLE_IDS.limitedChatUser);
  });

  it("rejects editing or deleting built-in roles", () => {
    const service = new RbacPolicyService(storeOptions);
    expect(
      service.upsertRole({
        id: RBAC_BUILT_IN_ROLE_IDS.admin,
        name: "Hacked",
        builtIn: false,
        permissions: [],
      }).ok,
    ).toBe(false);
    expect(service.deleteRole(RBAC_BUILT_IN_ROLE_IDS.admin).ok).toBe(false);
  });

  it("marks a custom role dangerous when it grants full access", () => {
    const service = new RbacPolicyService(storeOptions);
    service.upsertRole({
      id: "role_danger",
      name: "Danger",
      builtIn: false,
      permissions: ["message.reply", "thread.execution.full_access"],
    });
    const role = service.allRoles().find((r) => r.id === "role_danger");
    expect(role?.danger).toBe(true);
  });

  it("strips a deleted role from attachments", () => {
    const service = new RbacPolicyService(storeOptions);
    service.upsertRole({
      id: "role_x",
      name: "X",
      builtIn: false,
      permissions: ["message.reply"],
    });
    service.upsertAttachment({
      subject: { kind: "actor", platform: "slack", actorId: "U1" },
      roleIds: ["role_x", RBAC_BUILT_IN_ROLE_IDS.chatUser],
    });
    service.deleteRole("role_x");
    const attachment = service
      .attachments()
      .find((a) => a.subject.kind === "actor" && a.subject.actorId === "U1");
    expect(attachment?.roleIds).toEqual([RBAC_BUILT_IN_ROLE_IDS.chatUser]);
  });

  it("resolves per-platform capability through providerFor", () => {
    const service = new RbacPolicyService(storeOptions);
    service.upsertAttachment({
      subject: { kind: "actor", platform: "slack", actorId: "U1" },
      roleIds: [RBAC_BUILT_IN_ROLE_IDS.chatUser],
    });
    service.setEnforced(true);
    const provider = service.providerFor("slack");
    expect(provider.isEnforcing()).toBe(true);
    const resolution = provider.resolve({ actorId: "U1" });
    expect(resolution.permissions.has("message.reply")).toBe(true);
    expect(resolution.permissions.has("thread.resume")).toBe(false);
    // A different platform's controller sees nothing for this actor.
    expect(
      service.providerFor("telegram").resolve({ actorId: "U1" }).rejected,
    ).toBe(true);
  });

  it("audits every policy edit through the injected sink", () => {
    const entries: RecordMessagingActivityInput[] = [];
    const service = new RbacPolicyService(storeOptions, (entry) =>
      entries.push(entry),
    );

    service.upsertRole({
      id: "role_x",
      name: "X",
      builtIn: false,
      permissions: ["message.reply", "thread.execution.full_access"],
    });
    expect(entries.at(-1)).toMatchObject({
      kind: "policy",
      platform: "desktop",
      payload: { action: "role-created", roleId: "role_x", danger: true },
    });
    expect(entries.at(-1)?.summary).toContain("Codex Full Access");

    service.upsertRole({
      id: "role_x",
      name: "X",
      builtIn: false,
      permissions: ["message.reply"],
    });
    expect(entries.at(-1)?.payload).toMatchObject({
      action: "role-updated",
      previousPermissions: ["message.reply", "thread.execution.full_access"],
    });

    service.upsertAttachment({
      subject: { kind: "actor", platform: "slack", actorId: "U1" },
      roleIds: ["role_x"],
      displayName: "Alice",
    });
    expect(entries.at(-1)).toMatchObject({
      kind: "policy",
      platform: "slack",
      actorId: "U1",
      actorDisplayName: "Alice",
    });
    expect(entries.at(-1)?.summary).toBe("Roles for Alice set to X");

    service.deleteRole("role_x");
    expect(entries.at(-1)?.payload).toMatchObject({
      action: "role-deleted",
      detachedSubjects: 1,
    });

    service.setEnforced(true, [
      {
        subject: { kind: "actor", platform: "slack", actorId: "U1" },
        roleIds: [RBAC_BUILT_IN_ROLE_IDS.admin],
      },
    ]);
    expect(entries.at(-1)).toMatchObject({
      platform: "desktop",
      payload: { action: "enforcement-enabled", seededAttachments: 1 },
    });

    service.deleteAttachment({
      kind: "actor",
      platform: "slack",
      actorId: "U1",
    });
    expect(entries.at(-1)?.payload).toMatchObject({
      action: "attachment-deleted",
      previousRoleIds: [RBAC_BUILT_IN_ROLE_IDS.admin],
    });

    service.setEnforced(false);
    expect(entries.at(-1)?.payload).toMatchObject({
      action: "enforcement-disabled",
    });
    // Re-asserting the same value is not an audited change.
    const count = entries.length;
    service.setEnforced(false);
    expect(entries).toHaveLength(count);
  });

  it("does not audit no-op deletes of unknown roles or attachments", () => {
    const entries: RecordMessagingActivityInput[] = [];
    const service = new RbacPolicyService(storeOptions, (entry) =>
      entries.push(entry),
    );
    service.deleteRole("nope");
    service.deleteAttachment({
      kind: "actor",
      platform: "slack",
      actorId: "ghost",
    });
    expect(entries).toHaveLength(0);
  });

  it("seeds synthesized attachments only when enabling on an empty policy", () => {
    const service = new RbacPolicyService(storeOptions);
    service.setEnforced(true, [
      {
        subject: { kind: "actor", platform: "slack", actorId: "U1" },
        roleIds: [RBAC_BUILT_IN_ROLE_IDS.admin],
      },
    ]);
    expect(service.attachments()).toHaveLength(1);
    // Re-enabling does not clobber existing attachments.
    service.setEnforced(false);
    service.setEnforced(true, [
      {
        subject: { kind: "actor", platform: "slack", actorId: "U2" },
        roleIds: [RBAC_BUILT_IN_ROLE_IDS.admin],
      },
    ]);
    expect(service.attachments()).toHaveLength(1);
    expect(service.attachments()[0].subject).toMatchObject({ actorId: "U1" });
  });
});
