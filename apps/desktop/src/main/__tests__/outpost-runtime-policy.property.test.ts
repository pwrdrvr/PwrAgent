import path from "node:path";
import fc from "fast-check";
import { buildCodexClientArgs } from "../app-server/codex-thread-config";
import { expect, it } from "vitest";
import { assertOwnerExecutionPolicy, createOutpostRuntimePolicy, ownerSandboxForMode, type OwnerRuntimePolicy } from "../owner-runtime-policy";

const policy: OwnerRuntimePolicy = {
  enabledBackends: ["codex"], approvalPolicy: "never", executionModes: ["default", "auto"],
  sandboxByMode: { default: "read-only", auto: "workspace-write" }, federationEgressRole: "contained",
  codexProtectedRoots: [path.resolve("/srv/pwragent/profiles")],
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
