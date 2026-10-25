import { describe, expect, it } from "vitest";
import type { CodexThreadEnvironmentRuntime } from "@pwragent/shared";
import {
  setupVariablesForAgent,
  withAgentSetupVariablePolicy,
} from "../app-server/agent-setup-variables";

const runtime: CodexThreadEnvironmentRuntime = {
  environmentId: "node",
  environmentName: "Node",
  executionTarget: "local",
  shellEnvironment: { PATH: "/fixture/node/bin:/usr/bin", NVM_DIR: "/fixture/.nvm" },
};

describe("agent setup variables", () => {
  it("passes a local environment's captured variables when allowed", () => {
    expect(setupVariablesForAgent(runtime, true)).toEqual(runtime.shellEnvironment);
  });

  it("withholds them when the profile turns them off", () => {
    expect(setupVariablesForAgent(runtime, false)).toBeUndefined();
  });

  it("never passes a remote target's variables", () => {
    expect(setupVariablesForAgent({ ...runtime, executionTarget: "remote" }, true)).toBeUndefined();
    expect(setupVariablesForAgent(undefined, true)).toBeUndefined();
  });

  it("strips only the variables from a runtime and keeps it otherwise", () => {
    expect(withAgentSetupVariablePolicy(runtime, true)).toBe(runtime);
    expect(withAgentSetupVariablePolicy(runtime, false)).toEqual({
      environmentId: "node",
      environmentName: "Node",
      executionTarget: "local",
    });
    expect(runtime.shellEnvironment).toBeDefined();
  });
});
