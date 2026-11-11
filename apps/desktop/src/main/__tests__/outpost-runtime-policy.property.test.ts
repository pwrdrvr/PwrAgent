import fc from "fast-check";
import path from "node:path";
import { buildCodexClientArgs } from "../app-server/codex-thread-config";
import { expect, it } from "vitest";
import { applyOwnerCodexExecutionPolicy, buildOwnerCodexIsolationConfig, assertOwnerExecutionPolicy, createOutpostRuntimePolicy, type OwnerRuntimePolicy } from "../owner-runtime-policy";

const policy: OwnerRuntimePolicy = {
  enabledBackends: ["codex"], approvalPolicy: "never", executionModes: ["default", "auto"],
  sandboxByMode: { default: "read-only", auto: "workspace-write" }, federationEgressRole: "contained",
};
const fixtureEnvironment = {
  PWRAGENT_HOME: path.resolve("/oracle/state"),
  PWRAGENT_CODEX_HOME: path.resolve("/oracle/codex"),
  PWRAGENT_OUTPOST_WORKSPACE: path.resolve("/oracle/workspace"),
};
it("the Outpost host enables Codex only, independent of inherited provider environment", () => {
  fc.assert(fc.property(fc.constantFrom("claude", "acp:gemini", "codex,claude"), value => {
    expect(createOutpostRuntimePolicy({ ...fixtureEnvironment, PWRAGENT_HEADLESS_BACKENDS: value }).enabledBackends).toEqual(["codex"]);
  }));
});
it("rejects every unsafe explicit provider, mode, approval or sandbox combination before admission", () => {
  fc.assert(fc.property(
    fc.constantFrom("codex", "claude"), fc.constantFrom(undefined, "default", "auto", "full-access"),
    fc.constantFrom(undefined, "never", "on-request", "untrusted"), fc.constantFrom(undefined, "read-only", "workspace-write", "danger-full-access"),
    (backend, executionMode, approvalPolicy, sandbox) => {
      const request = { backend, executionMode, approvalPolicy, sandbox };
      const allowed = backend === "codex" && executionMode !== "full-access"
        && (approvalPolicy === undefined || approvalPolicy === "never") && sandbox !== "danger-full-access";
      if (allowed) expect(() => assertOwnerExecutionPolicy(policy, request)).not.toThrow();
      else expect(() => assertOwnerExecutionPolicy(policy, request)).toThrow();
      expect(() => assertOwnerExecutionPolicy(undefined, request)).not.toThrow();
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
    expect(values.get("sandbox_mode")).toBe('"read-only"');
    expect(values.get("sandbox_workspace_write.network_access")).toBe("false");
    expect(values.get("sandbox_workspace_write.exclude_tmpdir_env_var")).toBe("true");
    expect(values.get("sandbox_workspace_write.exclude_slash_tmp")).toBe("true");
  }));
});

it("every execution route selects a read-restricted profile and removes legacy sandbox overrides", () => {
  fc.assert(fc.property(
    fc.constantFrom("thread/start", "thread/resume", "thread/fork", "turn/start", "thread/settings/update", "command/exec"),
    fc.constantFrom("read-only", "workspace-write"),
    (method, sandbox) => {
      const actual = applyOwnerCodexExecutionPolicy(policy, method, {
        sandbox, sandboxPolicy: { type: "dangerFullAccess" },
        config: { permissions: { escape: {} }, "shell_environment_policy.set.TOKEN": "secret", features: { shell_snapshot: true, other: true } },
      }) as Record<string, unknown>;
      expect(actual.sandbox).toBeUndefined();
      expect(actual.sandboxPolicy).toBeUndefined();
      expect(actual[method === "command/exec" ? "permissionProfile" : "permissions"]).toBe(`pwragent-${sandbox}`);
      if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
        expect(actual.config).toEqual({ features: { other: true } });
      }
    },
  ));
});

it("provider credentials with arbitrary names never enter the command environment", () => {
  fc.assert(fc.property(fc.stringMatching(/^[A-Z][A-Z_]{1,24}$/).filter(key => !["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TMP", "TEMP"].includes(key)), key => {
    const config = buildOwnerCodexIsolationConfig({ ...policy, privateRoots: ["/private/owner", "/private/codex"] }, { [key]: "provider-secret", PATH: "/bin" });
    expect(config["shell_environment_policy.inherit"]).toBe("none");
    expect(config["shell_environment_policy.set"]).toEqual({ PATH: "/bin" });
    for (const name of ["read-only", "workspace-write"]) {
      expect(config[`permissions.pwragent-${name}.filesystem`]).toMatchObject({ "/private/owner": "deny", "/private/codex": "deny" });
    }
    const params = applyOwnerCodexExecutionPolicy(policy, "command/exec", { env: { [key]: "provider-secret", LANG: "C" } }) as Record<string, unknown>;
    expect(params.env).toEqual({ LANG: "C" });
  }));
});

it("a metadata-only settings update preserves the selected execution profile", () => {
  const params = { threadId: "thread", model: "model", reasoningEffort: "high" };
  expect(applyOwnerCodexExecutionPolicy(policy, "thread/settings/update", params)).toEqual(params);
});

it("command cwd cannot redefine the host-owned readable workspace", () => {
  const hostPolicy = createOutpostRuntimePolicy(fixtureEnvironment);
  const config = buildOwnerCodexIsolationConfig(hostPolicy, {});
  for (const name of ["read-only", "workspace-write"]) {
    const filesystem = config[`permissions.pwragent-${name}.filesystem`] as Record<string, unknown>;
    expect(filesystem[hostPolicy.workspaceRoot!]).toBe(name === "read-only" ? "read" : "write");
    expect(filesystem[":project_roots"]).toBeUndefined();
  }
  for (const root of ["/oracle/state", "/oracle/state/subdir", "/oracle", "/oracle/codex"]) {
    expect(() => createOutpostRuntimePolicy({ ...fixtureEnvironment, PWRAGENT_OUTPOST_WORKSPACE: root })).toThrow("must not overlap");
  }
});
