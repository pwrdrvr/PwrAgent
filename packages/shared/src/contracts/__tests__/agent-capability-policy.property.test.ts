import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  agentCapabilityRuntimeSupport,
  validateAgentCapabilityPolicy,
  type RestrictedAgentCapabilityPolicy,
} from "../agent-capability-policy";

const denyAll: RestrictedAgentCapabilityPolicy = {
  version: 1,
  mode: "restricted",
  executionModeCeiling: null,
  workspaceRoots: [],
  executables: [],
  mcpServers: [],
  skills: [],
  networkOrigins: [],
};

describe("Agent capability policy", () => {
  it("preserves explicit fail-closed semantics through serialization on every path", () => {
    fc.assert(fc.property(
      fc.constantFrom("codex", "claude", "acp:grok", "acp:gemini"),
      fc.constantFrom("interactive", "automation", "child"),
      fc.constantFrom(null, "default", "auto", "full-access"),
      fc.boolean(),
      (backend, path, executionModeCeiling, configured) => {
        const policy = {
          ...denyAll,
          executionModeCeiling,
          ...(configured ? {
            workspaceRoots: [{ path: "/work/jira", access: "read" }],
            executables: [{ path: "/usr/local/bin/jira", approval: "prompt" }],
            mcpServers: [{ source: "connection", id: "jira", tools: [{ name: "lookup", approval: "auto-approve" }] }],
            skills: ["jira-review"],
            networkOrigins: ["https://example.com"],
          } : {}),
        };
        const decoded: unknown = JSON.parse(JSON.stringify(policy));
        expect(validateAgentCapabilityPolicy(decoded)).toEqual({ ok: true, policy });
        expect(agentCapabilityRuntimeSupport(decoded, backend, path)).toEqual({ status: "unsupported", backend, path });
      },
    ));
  });

  it("rejects unknown versions and extended legacy envelopes", () => {
    fc.assert(fc.property(fc.integer({ min: 2 }), fc.jsonValue(), (version, payload) => {
      expect(agentCapabilityRuntimeSupport({ version, mode: "legacy" }, "codex", "interactive"))
        .toEqual({ status: "invalid", code: "unsupported-version", field: "version" });
      expect(agentCapabilityRuntimeSupport({ version: 1, mode: "legacy", payload }, "codex", "interactive"))
        .toEqual({ status: "invalid", code: "invalid", field: "legacy" });
    }));
  });

  it("accepts implicit legacy only when the runtime field is actually absent", () => {
    expect(validateAgentCapabilityPolicy(undefined)).toMatchObject({ ok: false });
    expect(agentCapabilityRuntimeSupport(null, "codex", "interactive")).toMatchObject({ status: "invalid" });
    expect(agentCapabilityRuntimeSupport(undefined, "codex", "interactive")).toEqual({ status: "legacy" });
    expect(agentCapabilityRuntimeSupport({ version: 1, mode: "legacy" }, "codex", "interactive")).toEqual({ status: "legacy" });
  });

  it.each([
    { workspaceRoots: [{ path: "workspace", access: "write" }] },
    { executables: [{ path: "/bin/*", approval: "prompt" }] },
    { skills: ["jira", "jira"] },
    { mcpServers: [{ source: "connection", id: "jira", tools: [{ name: "issue/*", approval: "auto-approve" }] }] },
    { networkOrigins: ["https://user:secret@example.com"] },
    { networkOrigins: ["https://example.com/api"] },
  ])("rejects ambiguous or malformed grants (%j)", (overrides) => {
    expect(validateAgentCapabilityPolicy({ ...denyAll, ...overrides })).toMatchObject({ ok: false });
  });
});
