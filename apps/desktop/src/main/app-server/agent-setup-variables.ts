import type { CodexThreadEnvironmentRuntime } from "@pwragent/shared";

/**
 * The shell variables an environment's setup captured (PATH, NVM_DIR, ...),
 * as an agent may receive them. Every provider that takes environment
 * variables at thread or turn start reads them through here, so the profile's
 * `general.pass_setup_variables_to_agents` opt-out holds for all of them.
 * Setup itself, and Run actions, read the runtime directly and are unaffected.
 */
export function setupVariablesForAgent(
  runtime: CodexThreadEnvironmentRuntime | undefined,
  passToAgents: boolean,
): Record<string, string> | undefined {
  if (!passToAgents || runtime?.executionTarget !== "local") {
    return undefined;
  }
  return runtime.shellEnvironment;
}

/** `runtime` without its captured variables, when the agent may not have them. */
export function withAgentSetupVariablePolicy<
  T extends CodexThreadEnvironmentRuntime | undefined,
>(runtime: T, passToAgents: boolean): T {
  if (passToAgents || !runtime?.shellEnvironment) {
    return runtime;
  }
  const { shellEnvironment: _withheld, ...rest } = runtime;
  return rest as T;
}
