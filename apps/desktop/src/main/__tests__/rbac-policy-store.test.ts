import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RBAC_BUILT_IN_ROLE_IDS, emptyRbacPolicy, type RbacPolicy } from "@pwragent/shared/contracts/rbac";

import {
  readRbacPolicy,
  readRbacPolicyState,
  resolveLegacyRbacPolicyJsonPath,
  resolveRbacConfigPath,
  writeRbacPolicy,
} from "../settings/rbac-policy-store";
import { RbacPolicyService } from "../messaging/rbac-policy-service";
import type { RecordMessagingActivityInput } from "../storage/messaging-activity-log";

let tmpHome: string;
let storeOptions: { env: NodeJS.ProcessEnv };
const actor = { actorId: "U1" };
const grantedToml = [
  "[messaging.rbac]",
  "enforced = true",
  "",
  "[[messaging.rbac.attachments]]",
  'platform = "slack"',
  'subject_kind = "actor"',
  `actor_id = "${actor.actorId}"`,
  'role_ids = ["chat_user"]',
  "",
].join("\n");
const grantedLegacyJson = JSON.stringify({
  enforced: true,
  attachments: [{
    subject: { ...actor, kind: "actor", platform: "slack" },
    roleIds: ["chat_user"],
  }],
});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-rbac-"));
  storeOptions = { env: { PWRAGENT_HOME: tmpHome, PWRAGENT_PROFILE: "default" } };
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it.each([
    ["garbled flag", grantedToml.replace("enforced = true", 'enforced = "yes"')],
    ["missing flag", grantedToml.replace("enforced = true", "")],
    ["child table only", '[messaging.rbac.attachments]\nplatform = "slack"\n'],
    ["RBAC array table", "[[messaging.rbac]]\nenforced = false\n"],
  ])("fails closed for configured TOML with %s", (_name, source) => {
    const configPath = resolveRbacConfigPath(storeOptions);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, source);
    fs.writeFileSync(resolveLegacyRbacPolicyJsonPath(storeOptions), grantedLegacyJson);
    expect(readRbacPolicyState(storeOptions)).toMatchObject({
      failClosed: true,
      policy: { enforced: true, attachments: [] },
    });
  });

  it("uses legacy fallback when malformed TOML has a similarly named unrelated table", () => {
    const configPath = resolveRbacConfigPath(storeOptions);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "[messaging.rbac-other]\n[broken");
    fs.writeFileSync(resolveLegacyRbacPolicyJsonPath(storeOptions), grantedLegacyJson);
    const state = readRbacPolicyState(storeOptions);
    expect(state.failClosed).toBe(false);
    expect(state.policy.attachments[0]?.roleIds).toEqual(["chat_user"]);
  });

  it("drops persisted roles that reuse a built-in id, and reports them", () => {
    const configPath = resolveRbacConfigPath(storeOptions);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        "[messaging.rbac]",
        "enforced = true",
        "",
        // A hand-edit trying to redefine the built-in Chat User with a
        // full-access grant. Must not shadow the real built-in.
        "[[messaging.rbac.roles]]",
        `id = "${RBAC_BUILT_IN_ROLE_IDS.chatUser}"`,
        'name = "Chat User"',
        'permissions = ["thread.execution.full_access"]',
        "",
        "[[messaging.rbac.roles]]",
        'id = "role_ok"',
        'name = "OK"',
        'permissions = ["message.reply"]',
        "",
      ].join("\n"),
    );
    const state = readRbacPolicyState(storeOptions);
    expect(state.ignoredReservedRoleIds).toEqual([
      RBAC_BUILT_IN_ROLE_IDS.chatUser,
    ]);
    expect(state.policy.roles.map((r) => r.id)).toEqual(["role_ok"]);

    // The genuine built-in still resolves, and the impostor's grant is gone.
    const service = new RbacPolicyService(storeOptions);
    const chatUser = service
      .allRoles()
      .filter((role) => role.id === RBAC_BUILT_IN_ROLE_IDS.chatUser);
    expect(chatUser).toHaveLength(1);
    expect(chatUser[0].permissions).not.toContain("thread.execution.full_access");

    service.upsertAttachment({
      subject: { kind: "actor", platform: "slack", actorId: "U1" },
      roleIds: [RBAC_BUILT_IN_ROLE_IDS.chatUser],
    });
    const resolution = service.providerFor("slack").resolve({ actorId: "U1" });
    expect(resolution.permissions.has("thread.execution.full_access")).toBe(false);
    expect(resolution.permissions.has("message.reply")).toBe(true);
  });

  it("re-reads the policy when the config changes underneath the cache", () => {
    const configPath = resolveRbacConfigPath(storeOptions);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const write = (roleIds: string) =>
      fs.writeFileSync(
        configPath,
        [
          "[messaging.rbac]",
          "enforced = true",
          "",
          "[[messaging.rbac.attachments]]",
          'platform = "slack"',
          'subject_kind = "actor"',
          'actor_id = "U1"',
          `role_ids = ${roleIds}`,
          "",
        ].join("\n"),
      );

    write(`["${RBAC_BUILT_IN_ROLE_IDS.admin}"]`);
    const service = new RbacPolicyService(storeOptions);
    const provider = service.providerFor("slack");
    expect(
      provider.resolve({ actorId: "U1" }).permissions.has("thread.resume"),
    ).toBe(true);

    // Simulate an external edit (hand-edit, or another instance on this
    // profile) revoking the role. The fingerprint must invalidate the cache.
    write("[]");
    const stat = fs.statSync(configPath);
    fs.utimesSync(configPath, stat.atime, new Date(stat.mtimeMs + 5_000));

    const after = provider.resolve({ actorId: "U1" });
    expect(after.rejected).toBe(true);
    expect(after.permissions.has("thread.resume")).toBe(false);
  });

  it("reports failClosed via readRbacPolicyState only on fail-closed paths", () => {
    // Absent config: not configured, not fail-closed.
    expect(readRbacPolicyState(storeOptions).failClosed).toBe(false);
    const configPath = resolveRbacConfigPath(storeOptions);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Corrupt TOML that still shows RBAC data: fail-closed.
    fs.writeFileSync(configPath, "[messaging.rbac]\nenforced = true\n[broken");
    expect(readRbacPolicyState(storeOptions).failClosed).toBe(true);
    // Healthy section: enforced but readable, so not fail-closed.
    fs.writeFileSync(configPath, "[messaging.rbac]\nenforced = true\n");
    const healthy = readRbacPolicyState(storeOptions);
    expect(healthy.failClosed).toBe(false);
    expect(healthy.policy.enforced).toBe(true);
  });

  it("fails CLOSED on an unparseable legacy JSON file", () => {
    const legacyPath = resolveLegacyRbacPolicyJsonPath(storeOptions);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, "{ not json");
    const policy = readRbacPolicy(storeOptions);
    expect(policy.enforced).toBe(true);
    expect(policy.attachments).toHaveLength(0);
  });

  it.each([
    grantedLegacyJson.replace('"enforced":true,', ""),
    grantedLegacyJson.replace('"enforced":true', '"enforced":"off"'),
    "[]",
  ])("fails closed for legacy JSON without a boolean enforcement flag (%s)", (source) => {
    const legacyPath = resolveLegacyRbacPolicyJsonPath(storeOptions);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, source);
    expect(readRbacPolicyState(storeOptions)).toMatchObject({
      failClosed: true,
      policy: { enforced: true, attachments: [] },
    });
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
  it.each([
    {
      name: "a TOML revocation",
      resolvePath: resolveRbacConfigPath,
      before: grantedToml,
      after: grantedToml.replace('["chat_user"]', "[]"),
      failClosed: false,
    },
    {
      name: "malformed TOML with an RBAC section",
      resolvePath: resolveRbacConfigPath,
      before: grantedToml,
      after: "[messaging.rbac]\nenforced = true\n[broken",
      failClosed: true,
    },
    {
      name: "a legacy JSON revocation",
      resolvePath: resolveLegacyRbacPolicyJsonPath,
      before: grantedLegacyJson,
      after: '{"enforced":true,"attachments":[]}',
      failClosed: false,
    },
  ])("matches a fresh decision after a same-size, same-mtime peer replacement ($name)", ({
    resolvePath, before, after, failClosed,
  }) => {
    const file = resolvePath(storeOptions);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const timestamp = new Date("2026-01-01T00:00:00Z");
    fs.writeFileSync(file, before);
    fs.utimesSync(file, timestamp, timestamp);
    const { size, mtimeNs } = fs.statSync(file, { bigint: true });
    const service = new RbacPolicyService(storeOptions);
    const provider = service.providerFor("slack");
    expect(provider.resolveIfEnforcing!(actor)?.permissions.has("message.reply")).toBe(true);

    const peerFile = `${file}.peer`;
    fs.writeFileSync(peerFile, after.padEnd(before.length));
    fs.utimesSync(peerFile, timestamp, timestamp);
    fs.renameSync(peerFile, file);
    expect(fs.statSync(file, { bigint: true })).toMatchObject({ size, mtimeNs });

    const fresh = new RbacPolicyService(storeOptions);
    const expected = fresh.providerFor("slack").resolveIfEnforcing!(actor);
    expect(expected?.rejected).toBe(true);
    expect(fresh.isFailClosed()).toBe(failClosed);
    expect(provider.resolveIfEnforcing!(actor)).toEqual(expected);
    expect(service.isFailClosed()).toBe(failClosed);
  });

  it("matches a fresh decision when a peer replaces a just-written policy", () => {
    const file = resolveRbacConfigPath(storeOptions);
    const peerFile = `${file}.peer`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(peerFile, "[messaging.rbac]\nenforced = true\n");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      rename(from, to);
      rename(peerFile, file);
    });

    const service = new RbacPolicyService(storeOptions, () => undefined);
    expect(service.setEnforced(true, [{
      subject: { ...actor, kind: "actor", platform: "slack" },
      roleIds: ["chat_user"],
    }])).toEqual({ ok: true });

    const fresh = new RbacPolicyService(storeOptions).providerFor("slack");
    const expected = fresh.resolveIfEnforcing!(actor);
    expect(expected?.rejected).toBe(true);
    expect(service.providerFor("slack").resolveIfEnforcing!(actor)).toEqual(expected);
  });

  it("uses two stats and no policy reads for an unchanged admission", () => {
    const file = resolveRbacConfigPath(storeOptions);
    const legacyFile = resolveLegacyRbacPolicyJsonPath(storeOptions);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, grantedToml);
    const provider = new RbacPolicyService(storeOptions).providerFor("slack");
    expect(provider.resolveIfEnforcing!(actor)?.rejected).toBe(false);

    const stat = vi.spyOn(fs, "statSync");
    const read = vi.spyOn(fs, "readFileSync");
    expect(provider.resolveIfEnforcing!(actor)?.rejected).toBe(false);
    expect(stat.mock.calls.map(([filePath]) => filePath)).toEqual([file, legacyFile]);
    expect(read).not.toHaveBeenCalled();
  });

  it("returns roles and attachments from one revision when a peer replaces the file during a read", () => {
    const file = resolveRbacConfigPath(storeOptions);
    const peerFile = `${file}.peer`;
    const source = grantedToml.replace('["chat_user"]', '["local-role"]')
      + '\n[[messaging.rbac.roles]]\nid = "local-role"\nname = "Local role"\npermissions = ["message.reply"]\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    fs.writeFileSync(peerFile, source.replaceAll("local-role", "other-role"));
    const read = fs.readFileSync;
    let replaced = false;
    vi.spyOn(fs, "readFileSync").mockImplementation((filePath, options) => {
      const result = read(filePath, options);
      if (filePath === file && !replaced) {
        fs.renameSync(peerFile, file);
        replaced = true;
      }
      return result;
    });

    const service = new RbacPolicyService(storeOptions);
    for (const roleId of ["local-role", "other-role"]) {
      const snapshot = service.read();
      expect(snapshot.attachments[0]?.roleIds).toEqual([roleId]);
      expect(snapshot.roles.find(({ builtIn }) => !builtIn)?.id).toBe(roleId);
    }
  });

  const policySources = [
    { name: "TOML", resolvePath: resolveRbacConfigPath, source: grantedToml },
    { name: "legacy JSON", resolvePath: resolveLegacyRbacPolicyJsonPath, source: grantedLegacyJson },
  ];

  it.each(policySources.flatMap((source) => [
    { ...source, fault: "read" },
    { ...source, fault: "stat and read" },
  ]))("fails closed during a $name $fault error and retries the next decision", ({
    resolvePath, source, fault,
  }) => {
    const file = resolvePath(storeOptions);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const service = new RbacPolicyService(storeOptions);
    const provider = service.providerFor("slack");
    expect(provider.resolveIfEnforcing!(actor)).toBeNull();

    fs.writeFileSync(file, source);
    let unavailable = true;
    const denied = Object.assign(new Error("Fixture file inaccessible"), { code: "EACCES" });
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((filePath, options) => {
      if (filePath === file && unavailable) throw denied;
      return read(filePath, options);
    });
    if (fault === "stat and read") {
      const stat = fs.statSync;
      vi.spyOn(fs, "statSync").mockImplementation(((filePath: fs.PathLike, options: fs.StatSyncOptions) => {
        if (filePath === file && unavailable) throw denied;
        return stat(filePath, options);
      }) as typeof fs.statSync);
    }

    expect(provider.resolveIfEnforcing!(actor)?.rejected).toBe(true);
    expect(service.isFailClosed()).toBe(true);
    unavailable = false;
    expect(provider.resolveIfEnforcing!(actor)?.permissions.has("message.reply")).toBe(true);
  });

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
