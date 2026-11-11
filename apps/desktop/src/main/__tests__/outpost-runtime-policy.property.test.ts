import path from "node:path";
import fc from "fast-check";
import { buildCodexClientArgs } from "../app-server/codex-thread-config";
import { OUTPOST_PERMISSION_PROFILE_IDS } from "../headless/outpost-codex-sandbox";
import { expect, it } from "vitest";
import { assertOwnerExecutionPolicy, createOutpostRuntimePolicy, ownerSandboxForMode, type OwnerRuntimePolicy } from "../owner-runtime-policy";

const policy: OwnerRuntimePolicy = {
  enabledBackends: ["codex"], approvalPolicy: "never", executionModes: ["default", "auto"],
  sandboxByMode: { default: "read-only", auto: "workspace-write" }, federationEgressRole: "contained",
  codexProtectedRoots: [path.resolve("/srv/pwragent/profiles")], codexReadOnlyRoots: [path.resolve("/srv/codex-home")], agentToolAllowlist: [],
};
it("the Outpost host enables Codex only, independent of inherited provider environment", () => {
  fc.assert(fc.property(fc.constantFrom("claude", "acp:gemini", "codex,claude"), value => {
    expect(createOutpostRuntimePolicy({ PWRAGENT_HEADLESS_BACKENDS: value }).enabledBackends).toEqual(["codex"]);
  }));
});
it("rejects every unsafe explicit provider, mode, approval or sandbox combination before admission", () => {
  fc.assert(fc.property(
    fc.constantFrom("codex", "claude"), fc.constantFrom(undefined, "default", "auto", "full-access"),
    fc.constantFrom(undefined, "never", "on-request", "untrusted"), fc.constantFrom(undefined, "read-only", "workspace-write", "danger-full-access"),
    (backend, executionMode, approvalPolicy, sandbox) => {
      const request = { backend, executionMode, approvalPolicy, sandbox };
      // The mode chooses the sandbox. A caller may restate it, never change it,
      // and a sandbox without a mode is refused before any queue accepts it.
      const modeSandbox = executionMode ? policy.sandboxByMode[executionMode] : undefined;
      const allowed = backend === "codex" && executionMode !== "full-access"
        && (approvalPolicy === undefined || approvalPolicy === "never") && sandbox !== "danger-full-access"
        && (sandbox === undefined || sandbox === modeSandbox);
      if (allowed) expect(() => assertOwnerExecutionPolicy(policy, request)).not.toThrow();
      else expect(() => assertOwnerExecutionPolicy(policy, request)).toThrow();
      expect(() => assertOwnerExecutionPolicy(undefined, request)).not.toThrow();
    },
  ));
});
it("the execution mode, not the caller, chooses the sandbox at every provider call site", () => {
  fc.assert(fc.property(
    fc.constantFrom("default", "auto", "full-access"), fc.option(fc.constantFrom("read-only", "workspace-write", "danger-full-access", "anything"), { nil: undefined }),
    (mode, requested) => {
      const expected = policy.sandboxByMode[mode];
      if (!expected || (requested !== undefined && requested !== expected)) {
        expect(() => ownerSandboxForMode(policy, mode, requested, "workspace-write")).toThrow();
      } else {
        expect(ownerSandboxForMode(policy, mode, requested, "workspace-write")).toBe(expected);
      }
      // Desktop has no policy: the caller's sandbox still wins there.
      expect(ownerSandboxForMode(undefined, mode, requested, "workspace-write")).toBe(requested ?? "workspace-write");
    },
  ));
});
it("uses the operator's enabled backends without relaxing unattended execution", () => {
  expect(() => assertOwnerExecutionPolicy({ ...policy, enabledBackends: ["codex", "claude"] }, { backend: "claude", approvalPolicy: "never", executionMode: "auto" })).not.toThrow();
  expect(() => assertOwnerExecutionPolicy({ ...policy, enabledBackends: ["codex", "claude"] }, { backend: "claude", executionMode: "full-access" })).toThrow();
});

it("the App Server launch configuration cannot grant approvals or tool network access", () => {
  fc.assert(fc.property(fc.string(), path => {
    const args = buildCodexClientArgs({ PATH: path }, [], [], policy);
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index++) {
      if (args[index] !== "-c") continue;
      const override = args[++index]!;
      const separator = override.indexOf("=");
      values.set(override.slice(0, separator), override.slice(separator + 1));
    }
    expect(values.get("approval_policy")).toBe('"never"');
    // Sandbox profiles and their deny entries: outpost-codex-sandbox.property.test.ts.
    expect(values.get("default_permissions")).toBe('"pwragent-outpost-read-only"');
    expect(values.get("permissions.pwragent-outpost-read-only.network.enabled")).toBe("false");
    expect(values.get("permissions.pwragent-outpost-workspace-write.network.enabled")).toBe("false");
  }));
});

function launchOverrides(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "-c") continue;
    const override = args[++index]!;
    const separator = override.indexOf("=");
    values.set(override.slice(0, separator), override.slice(separator + 1));
  }
  return values;
}

function profileNetwork(args: string[]): string[] {
  return Object.values(OUTPOST_PERMISSION_PROFILE_IDS)
    .map(id => launchOverrides(args).get(`permissions.${id}.network.enabled`) ?? "missing");
}

it("with no operator settings the Outpost keeps the locked-down policy", () => {
  const created = createOutpostRuntimePolicy({});
  expect(created.executionModes).toEqual(["default", "auto"]);
  expect(created.sandboxByMode).toEqual({ default: "read-only", auto: "workspace-write" });
  expect(created.agentNetwork).toBe(false);
  expect(created.federationEgressRole).toBe("contained");
  expect(profileNetwork(buildCodexClientArgs({}, [], [], created))).toEqual(["false", "false"]);
});

it("operator execution modes and agent network are independent, and admission follows exactly the allowed modes", () => {
  const allModes = ["default", "auto", "full-access"] as const;
  fc.assert(fc.property(
    fc.subarray([...allModes], { minLength: 1 }), fc.constantFrom(undefined, "", "off", "on", " ON "),
    fc.constantFrom(...allModes), fc.constantFrom(undefined, "read-only", "workspace-write", "danger-full-access"),
    (modes, network, requestedMode, sandbox) => {
      const created = createOutpostRuntimePolicy({ PWRAGENT_OUTPOST_EXECUTION_MODES: modes.join(" , "), PWRAGENT_OUTPOST_AGENT_NETWORK: network });
      expect(created.executionModes).toEqual(allModes.filter(mode => modes.includes(mode)));
      expect(created.agentNetwork).toBe(network?.trim().toLowerCase() === "on");
      expect(created.approvalPolicy).toBe("never");
      expect(created.federationEgressRole).toBe("contained");
      // Both Outpost permission profiles carry the operator's network choice,
      // and no legacy sandbox setting reaches Codex.
      const args = buildCodexClientArgs({}, [], [], created);
      expect(profileNetwork(args)).toEqual([String(created.agentNetwork), String(created.agentNetwork)]);
      expect([...launchOverrides(args).keys()].some(key => key.startsWith("sandbox"))).toBe(false);
      const sandboxOf = { default: "read-only", auto: "workspace-write", "full-access": "danger-full-access" } as const;
      // An allowed mode, and at most a restatement of that mode's own sandbox.
      const allowed = modes.includes(requestedMode)
        && (sandbox === undefined || sandbox === sandboxOf[requestedMode]);
      const request = { backend: "codex" as const, executionMode: requestedMode, approvalPolicy: "never", sandbox };
      if (allowed) expect(() => assertOwnerExecutionPolicy(created, request)).not.toThrow();
      else expect(() => assertOwnerExecutionPolicy(created, request)).toThrow();
    },
  ));
});

it("rejects unknown operator settings instead of falling back", () => {
  fc.assert(fc.property(fc.constantFrom("full", "yolo", "auto,danger", ",", " , "), value => {
    expect(() => createOutpostRuntimePolicy({ PWRAGENT_OUTPOST_EXECUTION_MODES: value })).toThrow();
  }));
  fc.assert(fc.property(fc.constantFrom("true", "1", "yes", "enabled"), value => {
    expect(() => createOutpostRuntimePolicy({ PWRAGENT_OUTPOST_AGENT_NETWORK: value })).toThrow();
  }));
});
