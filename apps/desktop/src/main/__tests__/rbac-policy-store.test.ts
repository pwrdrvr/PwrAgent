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
  resolveRbacPolicyPath,
  writeRbacPolicy,
} from "../settings/rbac-policy-store";
import { RbacPolicyService } from "../messaging/rbac-policy-service";

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
  it("returns an empty unenforced policy when the file is absent", () => {
    const policy = readRbacPolicy(storeOptions);
    expect(policy).toEqual(emptyRbacPolicy());
  });

  it("round-trips a policy through disk", () => {
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
    expect(fs.existsSync(resolveRbacPolicyPath(storeOptions))).toBe(true);
    expect(readRbacPolicy(storeOptions)).toEqual(policy);
  });

  it("forces persisted roles to builtIn:false and drops malformed entries", () => {
    const file = resolveRbacPolicyPath(storeOptions);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        policyVersion: 1,
        enforced: true,
        roles: [
          { id: "ok", name: "OK", builtIn: true, permissions: ["message.reply"] },
          { name: "no id", permissions: [] },
          "garbage",
        ],
        attachments: [
          { subject: { kind: "actor", platform: "slack", actorId: "U1" }, roleIds: ["ok"] },
          { subject: { kind: "bogus" }, roleIds: ["ok"] },
        ],
      }),
    );
    const policy = readRbacPolicy(storeOptions);
    expect(policy.roles).toHaveLength(1);
    expect(policy.roles[0]).toMatchObject({ id: "ok", builtIn: false });
    expect(policy.attachments).toHaveLength(1);
  });

  it("fails safe to empty policy on malformed JSON", () => {
    const file = resolveRbacPolicyPath(storeOptions);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(readRbacPolicy(storeOptions)).toEqual(emptyRbacPolicy());
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
