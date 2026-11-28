import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_TRUST_PROPERTY_MAX_AGE_MS,
  evaluateAgentTrustPolicy,
  isAgentTrustPolicy,
  type AgentTrustEvidence,
  type AgentTrustPolicy,
} from "../agent-trust-policy";

const now = 20_000;
const evidence: AgentTrustEvidence = {
  provider: "slack",
  conversation: { kind: "thread", id: "1700000000.000001", parentId: "C1", workspaceId: "T1" },
  actorId: "U1",
  roleIds: ["operator"],
};
const slackAdminPolicy: AgentTrustPolicy = { version: 1, denialResponse: "silent", rules: [{
  provider: "slack", allOf: [{ kind: "provider-property", key: "slack.workspace-admin", value: true }],
}] };
const invalidPolicy = { allowed: false, reason: "invalid-policy", respond: false };

describe("Agent invocation trust", () => {
  it("requires one whole rule: constraints from different alternatives never combine", () => {
    const switches = fc.record({ platform: fc.boolean(), connection: fc.boolean(),
      conversation: fc.boolean(), actor: fc.boolean(), role: fc.boolean(), property: fc.boolean() });
    fc.assert(fc.property(fc.array(switches, { maxLength: 8 }), (rules) => {
      const policy: AgentTrustPolicy = {
        version: 1,
        denialResponse: "silent",
        rules: rules.map((rule) => ({
          provider: rule.platform ? "slack" : "discord",
          connectionId: rule.connection ? undefined : "other-connection",
          conversation: { ...evidence.conversation, parentId: rule.conversation ? "C1" : "C2" },
          allOf: [
            { kind: "actor-id", actorId: rule.actor ? "U1" : "U2" },
            { kind: "rbac-role", roleId: rule.role ? "operator" : "admin" },
            ...(rule.property ? [] : [{ kind: "provider-property", key: "slack.workspace-admin", value: true } as const]),
          ],
        })),
      };
      // The Discord branch cannot use Slack's property grammar.
      const valid = policy.rules.every((rule) => rule.provider === "slack" || rule.allOf.length === 2);
      expect(isAgentTrustPolicy(policy)).toBe(valid);
      expect(evaluateAgentTrustPolicy(policy, evidence, now).allowed).toBe(
        valid && rules.some((rule) => Object.values(rule).every(Boolean)),
      );
    }));
  });

  it("binds verified properties to the requesting actor, workspace, and freshness window", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.integer({ min: -1, max: 2 }),
      (present, actorMatches, workspaceMatches, delta) => {
        const age = AGENT_TRUST_PROPERTY_MAX_AGE_MS + delta;
        const decision = evaluateAgentTrustPolicy(slackAdminPolicy, {
          ...evidence,
          workspaceAdmin: present ? {
            actorId: actorMatches ? "U1" : "U2", workspaceId: workspaceMatches ? "T1" : "T2", observedAt: now - age,
          } : undefined,
        }, now);
        expect(decision.allowed).toBe(present && actorMatches && workspaceMatches && age <= AGENT_TRUST_PROPERTY_MAX_AGE_MS);
      }));
  });

  it.each(["", " "])("rejects Slack admin evidence when both workspace IDs are %j", (workspaceId) => {
    expect(evaluateAgentTrustPolicy(slackAdminPolicy, {
      ...evidence,
      conversation: { ...evidence.conversation, workspaceId },
      workspaceAdmin: { actorId: evidence.actorId, workspaceId, observedAt: now },
    }, now)).toEqual({ allowed: false, reason: "actor-property", respond: false });
  });

  it("matches exact persisted role IDs while preserving other rules in the policy", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 24 }), (name) => {
      const roleId = ` ${name} `;
      const policy: AgentTrustPolicy = { version: 1, denialResponse: "silent", rules: [
        { provider: "slack", allOf: [{ kind: "rbac-role", roleId }] },
        { provider: "slack", allOf: [{ kind: "actor-id", actorId: "U2" }] },
      ] };
      expect(isAgentTrustPolicy(policy)).toBe(true);
      expect(evaluateAgentTrustPolicy(policy, { ...evidence, roleIds: [roleId] }, now)).toEqual({ allowed: true });
      expect(evaluateAgentTrustPolicy(policy, { ...evidence, roleIds: [roleId.trim()] }, now))
        .toEqual({ allowed: false, reason: "actor", respond: false });
      expect(evaluateAgentTrustPolicy(policy, { ...evidence, actorId: "U2", roleIds: [] }, now)).toEqual({ allowed: true });
    }));
  });

  it.each([
    { ruleCount: 31, requirementCount: 1, valid: true },
    { ruleCount: 32, requirementCount: 8, valid: true },
    { ruleCount: 33, requirementCount: 1, valid: false },
    { ruleCount: 1, requirementCount: 0, valid: false },
    { ruleCount: 1, requirementCount: 7, valid: true },
    { ruleCount: 1, requirementCount: 9, valid: false },
  ])("validates $ruleCount rules with $requirementCount actor requirements each", ({ ruleCount, requirementCount, valid }) => {
    const policy: AgentTrustPolicy = {
      version: 1,
      denialResponse: "generic",
      rules: Array.from({ length: ruleCount }, () => ({
        provider: "slack",
        allOf: Array.from({ length: requirementCount }, () => ({ kind: "actor-id", actorId: evidence.actorId })),
      })),
    };
    expect(isAgentTrustPolicy(policy)).toBe(valid);
    expect(evaluateAgentTrustPolicy(policy, evidence, now)).toEqual(valid ? { allowed: true } : invalidPolicy);
  });

  it("distinguishes inherited, deny-all and unrecognized policies", () => {
    expect(evaluateAgentTrustPolicy(undefined, evidence, now)).toEqual({ allowed: true });
    expect(evaluateAgentTrustPolicy({ version: 1, denialResponse: "generic", rules: [] }, evidence, now))
      .toEqual({ allowed: false, reason: "no-rules", respond: true });
    expect(evaluateAgentTrustPolicy({ version: 2, denialResponse: "generic", rules: [] }, evidence, now))
      .toEqual(invalidPolicy);
  });
});
