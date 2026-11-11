import type { AppServerBackendKind, FederationPeerRole, ThreadExecutionMode } from "@pwragent/shared";
import os from "node:os";
import path from "node:path";

/** Host configuration; desktop leaves this unset. */
export interface OwnerRuntimePolicy {
  codexCommand?: string;
  codexHome?: string;
  exclusiveProfileOwner?: boolean;
  enabledBackends: readonly AppServerBackendKind[];
  approvalPolicy: "never";
  executionModes: readonly ThreadExecutionMode[];
  sandboxByMode: Readonly<Partial<Record<ThreadExecutionMode, "read-only" | "workspace-write">>>;
  federationEgressRole: FederationPeerRole;
  privateRoots?: readonly string[];
  workspaceRoot?: string;
}
export interface OwnerExecutionRequest {
  backend: AppServerBackendKind;
  executionMode?: ThreadExecutionMode;
  approvalPolicy?: string;
  sandbox?: string;
}
export function assertOwnerExecutionPolicy(policy: OwnerRuntimePolicy | undefined, request: OwnerExecutionRequest): void {
  if (!policy) return;
  if (!policy.enabledBackends.includes(request.backend)) throw new Error(`Backend ${request.backend} is disabled by this host's configuration.`);
  if (request.executionMode && !policy.executionModes.includes(request.executionMode)) throw new Error("Full access is unavailable on this Outpost.");
  if (request.approvalPolicy !== undefined && request.approvalPolicy !== policy.approvalPolicy) throw new Error("This unattended Outpost requires approvalPolicy never.");
  if (request.sandbox !== undefined && request.sandbox !== "read-only" && request.sandbox !== "workspace-write") throw new Error("This Outpost requires a read-only or workspace-write sandbox.");
}

export function createOutpostRuntimePolicy(env: NodeJS.ProcessEnv = process.env): OwnerRuntimePolicy {
  const privateRoots = [path.resolve(env.PWRAGENT_HOME?.trim() || path.join(os.homedir(), ".pwragent")), path.resolve(env.PWRAGENT_CODEX_HOME?.trim() || env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex")),
    ...(process.platform === "linux" ? ["/run/codex-auth"] : [])];
  const workspaceRoot = path.resolve(env.PWRAGENT_OUTPOST_WORKSPACE?.trim() || process.cwd());
  for (const root of privateRoots) {
    if (root === workspaceRoot || root.startsWith(workspaceRoot + path.sep) || workspaceRoot.startsWith(root + path.sep) || workspaceRoot === path.parse(workspaceRoot).root || root === path.parse(root).root) {
      throw new Error("The Outpost workspace and owner credential roots must not overlap.");
    }
  }
  return { exclusiveProfileOwner: true, codexCommand: env.PWRAGENT_CODEX_COMMAND, codexHome: env.PWRAGENT_CODEX_HOME, enabledBackends: ["codex"], approvalPolicy: "never",
    privateRoots, workspaceRoot,
    executionModes: ["default", "auto"], sandboxByMode: { default: "read-only", auto: "workspace-write" }, federationEgressRole: "contained" };
}

const ISOLATED_PROFILES = { "read-only": "pwragent-read-only", "workspace-write": "pwragent-workspace-write" } as const;
const COMMAND_ENVIRONMENT = new Set(["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TMP", "TEMP"]);

/** Read allowlist, not just write containment. Codex owns platform defaults. */
export function buildOwnerCodexIsolationConfig(policy: OwnerRuntimePolicy, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const config: Record<string, unknown> = {
    default_permissions: ISOLATED_PROFILES["read-only"],
    allow_login_shell: false,
    "features.shell_snapshot": false,
    "shell_environment_policy.inherit": "none",
    "shell_environment_policy.set": Object.fromEntries(Object.entries(env).filter(([key, value]) => COMMAND_ENVIRONMENT.has(key) && value !== undefined)),
  };
  for (const [mode, name] of Object.entries(ISOLATED_PROFILES)) {
    const prefix = `permissions.${name}`;
    config[`${prefix}.filesystem`] = {
      ":minimal": "read",
      "/usr": "read",
      "/bin": "read",
      "/sbin": "read",
      "/lib": "read",
      "/lib64": "read",
      "/opt": "read",
      "/System/Library/OpenSSL": "read",
      // A command's cwd is agent-controlled. It must never redefine the
      // readable workspace, including when it points into a credential root.
      [policy.workspaceRoot ?? process.cwd()]: mode === "workspace-write" ? "write" : "read",
      ...Object.fromEntries((policy.privateRoots ?? []).map(root => [root, "deny"])),
    };
    config[`${prefix}.network.enabled`] = false;
  }
  return config;
}

function isIsolationConfigKey(key: string): boolean {
  return ["permissions", "default_permissions", "sandbox_mode", "sandbox_workspace_write", "shell_environment_policy", "allow_login_shell", "features.shell_snapshot"].some(managed => key === managed || key.startsWith(managed + "."));
}

/** Last host-owned boundary for every execution request, including helpers. */
export function applyOwnerCodexExecutionPolicy(policy: OwnerRuntimePolicy, method: string, params: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  if (!["thread/start", "thread/resume", "thread/fork", "thread/settings/update", "turn/start", "command/exec"].includes(method)) return params;
  const result = { ...params } as Record<string, unknown>;
  if (method !== "command/exec" && (method !== "thread/settings/update" || result.approvalPolicy !== undefined)) {
    result.approvalPolicy = policy.approvalPolicy;
  }
  if (method === "thread/settings/update" && !result.sandbox && !result.sandboxPolicy) return result;
  const sandboxPolicy = result.sandboxPolicy as { type?: string } | undefined;
  const sandbox = result.sandbox ?? (sandboxPolicy?.type === "workspaceWrite" ? "workspace-write" : sandboxPolicy?.type === "dangerFullAccess" ? "danger-full-access" : "read-only");
  if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new Error("This Outpost requires a read-only or workspace-write sandbox.");
  delete result.sandbox;
  delete result.sandboxPolicy;
  result[method === "command/exec" ? "permissionProfile" : "permissions"] = ISOLATED_PROFILES[sandbox];
  if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
    const config = result.config && typeof result.config === "object" ? result.config as Record<string, unknown> : {};
    const sanitized = Object.fromEntries(Object.entries(config).filter(([key]) => !isIsolationConfigKey(key)));
    if (sanitized.features && typeof sanitized.features === "object") {
      const { shell_snapshot: _snapshot, ...features } = sanitized.features as Record<string, unknown>;
      sanitized.features = features;
    }
    result.config = sanitized;
  }
  if (method === "command/exec" && result.env && typeof result.env === "object") {
    result.env = Object.fromEntries(Object.entries(result.env).filter(([key]) => COMMAND_ENVIRONMENT.has(key)));
  }
  return result;
}

export function ownerCodexIsolationArgs(policy: OwnerRuntimePolicy, env: NodeJS.ProcessEnv): string[] {
  // JSON values are valid TOML except objects; render those as inline tables.
  const toml = (value: unknown): string => value && typeof value === "object" && !Array.isArray(value)
    ? `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`).join(", ")} }`
    : JSON.stringify(value);
  return Object.entries(buildOwnerCodexIsolationConfig(policy, env)).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]);
}
