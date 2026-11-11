import type { OwnerRuntimePolicy } from "../owner-runtime-policy";
import { MCP_PROJECT_TOOL_APPROVAL_OFFER_META_KEY } from "@pwragent/shared";
import { PWRAGENT_MCP_SERVER_HASH_LENGTH, PWRAGENT_MCP_SERVER_PREFIX } from "../../shared/tool-activity";
import {
  buildCodexModelProviderConfigOverrides,
  buildCodexModelProviderShellEnvOverrides,
  codexModelProviderApiKeyEnv,
  type CodexModelProviderSettings,
} from "@pwragent/shared";
import { validateCodexConfigOverrides } from "../settings/codex-config-overrides";
import { buildOutpostCodexPermissionOverrides, isOutpostManagedConfigKey } from "../headless/outpost-codex-sandbox";
import { createHash } from "node:crypto";
import type {
  DynamicToolSpec as CodexDynamicToolSpec,
  ThreadStartParams as CodexThreadStartParams,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import { MCP_CONNECTION_CODEX_TOOL_TIMEOUT_SECONDS, MCP_CONNECTION_STARTUP_TIMEOUT_SECONDS } from "../mcp-connections/mcp-connection-timeouts";
import { type McpConnectionBridgeRegistration } from "../mcp-connections/mcp-connection-gateway-service";
import {
  type AppServerPendingRequestNotification,
  MCP_CONNECTION_DISPLAY_NAMES,
  isBuiltInMcpConnectionId,
} from "@pwragent/shared";
import { type CodexServerCapabilities } from "../codex-app-server/desktop-client";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { TOKEN_MISER_BRIDGE_DESCRIPTOR_ENV } from "../token-miser/token-miser-hook-bridge";
import {
  TOKEN_MISER_CODE_MODE_MAX_RESPONSE_BYTES,
  TOKEN_MISER_MODEL_VISIBLE_CAP_TOKENS,
} from "../token-miser/token-miser-types";
import { TokenMiserService } from "../token-miser/token-miser-service";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import { type AgentToolMcpRegistration } from "../agent-tools/agent-tool-mcp-server";



export function buildCodexClientArgs(
  env?: NodeJS.ProcessEnv,
  configOverrides: readonly string[] = [],
  modelProviders: readonly CodexModelProviderSettings[] = [],
  policy?: OwnerRuntimePolicy,
): string[] {
  // A provider's env_key is named only when its key is in this spawn's
  // environment; Codex would otherwise fail every request for a missing key.
  const providerIdsWithKeys = new Set(modelProviders
    .filter((provider) => env?.[codexModelProviderApiKeyEnv(provider.id)])
    .map((provider) => provider.id));
  const args = [
    // Provider tables first, so an operator's own override still wins.
    ...buildCodexModelProviderConfigOverrides(modelProviders, providerIdsWithKeys)
      .flatMap((override) => ["-c", override]),
    ...validateCodexConfigOverrides(configOverrides).flatMap((override) => {
      if (policy && isOutpostManagedConfigKey(override.slice(0, override.indexOf("=")))) {
        throw new Error("models.codex.config_overrides conflicts with the Outpost's Codex sandbox settings.");
      }
      return ["-c", override];
    }),
    "-c",
    `approval_policy=${JSON.stringify(policy?.approvalPolicy ?? "on-request")}`,
    // An Outpost selects named permission profiles that deny its own state.
    // Codex prefers a legacy `sandbox_mode`, so an Outpost never sets one.
    ...(policy
      ? buildOutpostCodexPermissionOverrides(policy.codexProtectedRoots, {
        readOnlyRoots: policy.codexReadOnlyRoots,
        network: policy.agentNetwork === true,
      }).flatMap((override) => ["-c", override])
      : ["-c", `sandbox_mode=${JSON.stringify("workspace-write")}`]),
    // PwrAgent already waits for idle before unsubscribing; unload without
    // a second Codex delay once the last subscriber leaves an inactive thread.
    "-c",
    "thread_unload_delay_secs=0",
  ];
  const pathValue = env?.PATH?.trim();
  if (pathValue) {
    args.push(
      "-c",
      `shell_environment_policy.set.PATH=${formatTomlString(pathValue)}`,
    );
  }
  const codexHome = env?.CODEX_HOME?.trim();
  if (codexHome) {
    args.push(
      "-c",
      `shell_environment_policy.set.CODEX_HOME=${formatTomlString(codexHome)}`,
    );
  }
  // Last, so no operator override can hand a provider key to model commands.
  args.push(...buildCodexModelProviderShellEnvOverrides(providerIdsWithKeys)
    .flatMap((override) => ["-c", override]));
  return args;
}

export function withTokenMiserBridgeDescriptorEnv(
  env: NodeJS.ProcessEnv,
  descriptorPath: string | undefined,
): NodeJS.ProcessEnv;
export function withTokenMiserBridgeDescriptorEnv(
  env: NodeJS.ProcessEnv | undefined,
  descriptorPath: string | undefined,
): NodeJS.ProcessEnv | undefined;
export function withTokenMiserBridgeDescriptorEnv(
  env: NodeJS.ProcessEnv | undefined,
  descriptorPath: string | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!descriptorPath) {
    return env;
  }
  return {
    ...(env ?? process.env),
    [TOKEN_MISER_BRIDGE_DESCRIPTOR_ENV]: descriptorPath,
  };
}

export function formatTomlString(value: string): string {
  return JSON.stringify(value);
}

export function schemaRequiredKeys(schema: Record<string, unknown>): string[] {
  const required = schema.required;
  if (Array.isArray(required)) {
    return required.filter((key): key is string => typeof key === "string");
  }
  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    return Object.keys(properties as Record<string, unknown>);
  }
  return [];
}

export function isNonEmptyStructuredValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== undefined && value !== null;
}

export function schemaPropertyAllowsNull(
  schema: Record<string, unknown>,
  key: string,
): boolean {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") {
    return false;
  }
  const property = (properties as Record<string, unknown>)[key];
  if (!property || typeof property !== "object") {
    return false;
  }
  const type = (property as Record<string, unknown>).type;
  return type === "null" || (Array.isArray(type) && type.includes("null"));
}

export function structuredRequiredFieldMatches(
  schema: Record<string, unknown>,
  record: Record<string, unknown>,
  key: string,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return false;
  }
  return record[key] === null
    ? schemaPropertyAllowsNull(schema, key)
    : isNonEmptyStructuredValue(record[key]);
}

export function buildCodexParentDynamicToolSpecs(
  agentToolCatalogs: Array<{ dynamicTools: CodexDynamicToolSpec[] }> = [],
): CodexDynamicToolSpec[] {
  return mergeCodexDynamicToolSpecs(
    agentToolCatalogs.flatMap((catalog) => catalog.dynamicTools),
  );
}

export function buildCodexTokenMiserDynamicToolSpecs(
  store: TokenMiserStore | undefined,
  focused?: TokenMiserService["focused"],
): CodexDynamicToolSpec[] {
  if (!store) {
    return [];
  }
  return buildCodexParentDynamicToolSpecs(
    resolveAgentToolCatalogs({ tokenMiserStore: store, tokenMiserFocused: focused }).filter(
      (catalog) => catalog.id === "token_miser",
    ),
  );
}

export const PWRAGENT_PDF_MCP_SERVER_NAME = "pwragent_pdf";

export function buildCodexPdfMcpConfig(
  registration: AgentToolMcpRegistration,
): CodexThreadStartParams["config"] {
  return {
    mcp_servers: {
      [PWRAGENT_PDF_MCP_SERVER_NAME]: {
        enabled: true,
        http_headers: Object.fromEntries(
          registration.server.headers.map(({ name, value }) => [name, value]),
        ),
        url: registration.server.url,
      },
    },
  } as CodexThreadStartParams["config"];
}

export function buildCodexPdfMcpDisabledConfig(): CodexThreadStartParams["config"] {
  return {
    mcp_servers: {
      [PWRAGENT_PDF_MCP_SERVER_NAME]: {
        enabled: false,
      },
    },
  } as CodexThreadStartParams["config"];
}

export function withoutMcpProjectToolApprovalOffer(
  request: AppServerPendingRequestNotification,
): AppServerPendingRequestNotification {
  const meta = request.params._meta;
  if (!meta || typeof meta !== "object" || !(MCP_PROJECT_TOOL_APPROVAL_OFFER_META_KEY in meta)) return request;
  const { [MCP_PROJECT_TOOL_APPROVAL_OFFER_META_KEY]: _offer, ...rest } = meta as Record<string, unknown>;
  return { ...request, params: { ...request.params, _meta: rest } } as AppServerPendingRequestNotification;
}

export function buildCodexConnectionMcpServerName(
  server: McpConnectionBridgeRegistration["server"],
): string {
  const identity = createHash("sha256")
    .update(server.command)
    .update("\0")
    .update(server.args.join("\0"))
    .update("\0")
    .update(
      Object.entries(server.env)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}\0${value}`)
        .join("\0"),
    )
    .digest("hex")
    .slice(0, PWRAGENT_MCP_SERVER_HASH_LENGTH);
  return `${PWRAGENT_MCP_SERVER_PREFIX}${server.name}_${identity}`;
}

/**
 * Thrown when a thread asked for PwrAgent-only MCP access and PwrAgent cannot
 * prove it delivered it.
 *
 * Isolation is expressed as `{ enabled: false }` overrides for the servers
 * Codex inherited, which requires reading that inventory. When the running
 * Codex build cannot report it, continuing would run the turn with the
 * operator's other MCP servers still live while the UI claimed otherwise.
 * Refusing is the honest failure.
 */
export function codexMcpIsolationUnavailableError(): Error {
  return new Error(
    "This thread is set to use PwrAgent connections only, but the installed Codex build cannot report its configured MCP servers, so PwrAgent cannot turn them off. Update Codex, or allow the agent's own MCP servers for this thread.",
  );
}

export function buildCodexConnectionMcpConfig(
  registrations: McpConnectionBridgeRegistration[],
  inheritedServerNames?: readonly string[],
  options: { isolateFromInherited?: boolean } = {},
): CodexThreadStartParams["config"] | undefined {
  if (registrations.length === 0 && !options.isolateFromInherited) {
    return undefined;
  }
  const inheritedNames = new Set(inheritedServerNames ?? []);
  // "PwrAgent connections only" is expressed the same way a collision is:
  // an `{ enabled: false }` override for a server Codex actually inherited.
  // Naming a server Codex does not have would create a transport-less entry
  // that Codex rejects, so an unavailable inventory yields no overrides at
  // all -- which is why the caller refuses the turn instead of pretending.
  const isolationOverrides = options.isolateFromInherited
    ? [...inheritedNames].map((name) => [name, { enabled: false }] as const)
    : [];
  return {
    mcp_servers: Object.fromEntries([
      ...isolationOverrides,
      ...registrations.flatMap(({ server }) => {
        // Codex recursively merges thread config over the operator's global
        // config. Disable only aliases that were actually inherited: a new
        // `{ enabled: false }` entry has no command or URL, which Codex
        // correctly rejects as a transport-less MCP server. The bridge itself
        // always receives a unique hashed name so it cannot mix with an
        // inherited HTTP server.
        const aliases = [
          server.name,
          `${PWRAGENT_MCP_SERVER_PREFIX}${server.name}`,
        ].filter((name) => inheritedNames.has(name));
        return [
          ...aliases.map((name) => [name, { enabled: false }] as const),
          [
            buildCodexConnectionMcpServerName(server),
            {
              enabled: true,
              command: server.command,
              args: server.args,
              env: server.env,
              startup_timeout_sec: MCP_CONNECTION_STARTUP_TIMEOUT_SECONDS,
              tool_timeout_sec: MCP_CONNECTION_CODEX_TOOL_TIMEOUT_SECONDS,
            },
          ] as const,
        ];
      }),
    ]),
  } as CodexThreadStartParams["config"];
}

/**
 * Codex rejects the whole thread config when an inherited MCP alias cannot be
 * disabled cleanly. That is PwrAgent's configuration failing, not the app
 * behind the connection, and the message says so for whichever connections
 * the thread enabled rather than blaming PwrSnap for a PwrGit entry.
 */
export function userActionableMcpConnectionConfigError(
  error: unknown,
  registrations: McpConnectionBridgeRegistration[],
): unknown {
  const names = registrations.map(({ server }) =>
    isBuiltInMcpConnectionId(server.name)
      ? MCP_CONNECTION_DISPLAY_NAMES[server.name]
      : server.name,
  );
  if (
    names.length === 0
    || !(error instanceof Error)
    || !/invalid transport\s+in\s+`?mcp_servers\./.test(error.message)
  ) {
    return error;
  }
  const subject = `${names.join(" and ")} ${names.length === 1 ? "was" : "were"}`;
  return new Error(
    `${subject} not contacted: Codex rejected PwrAgent's temporary MCP configuration. Update PwrAgent and retry the thread. If this still happens after updating, repair or remove the named MCP server in Codex configuration. Details: `
      + error.message,
    { cause: error },
  );
}

export function mergeCodexThreadConfigs(
  ...configs: Array<CodexThreadStartParams["config"] | undefined>
): CodexThreadStartParams["config"] | undefined {
  const present = configs.filter(
    (config): config is NonNullable<CodexThreadStartParams["config"]> =>
      config !== undefined,
  );
  if (present.length === 0) return undefined;
  const merged = present.reduce<Record<string, unknown>>(
    (result, config) => {
      const record = config as Record<string, unknown>;
      const currentServers = result.mcp_servers;
      const nextServers = record.mcp_servers;
      const currentFeatures = result.features;
      const nextFeatures = record.features;
      return {
        ...result,
        ...record,
        ...(currentServers && nextServers
          ? {
              mcp_servers: {
                ...(currentServers as Record<string, unknown>),
                ...(nextServers as Record<string, unknown>),
              },
            }
          : {}),
        ...(isConfigRecord(currentFeatures) && isConfigRecord(nextFeatures)
          ? {
              features: mergeCodexFeatureConfigs(
                currentFeatures,
                nextFeatures,
              ),
            }
          : {}),
      };
    },
    {},
  );
  return merged as CodexThreadStartParams["config"];
}

export function mergeCodexFeatureConfigs(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const currentCodeMode = current.code_mode;
  const nextCodeMode = next.code_mode;
  if (!isConfigRecord(currentCodeMode) || !isConfigRecord(nextCodeMode)) {
    return { ...current, ...next };
  }
  const currentReducer = currentCodeMode.output_reducer;
  const nextReducer = nextCodeMode.output_reducer;
  return {
    ...current,
    ...next,
    code_mode: {
      ...currentCodeMode,
      ...nextCodeMode,
      ...(isConfigRecord(currentReducer) && isConfigRecord(nextReducer)
        ? { output_reducer: { ...currentReducer, ...nextReducer } }
        : {}),
    },
  };
}

export function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Configures the reducer added by pwrdrvr/codex at the script-to-model
 * boundary. This does not enable Code Mode; it only applies when the thread's
 * existing model/config selects it. Direct tool calls continue through the
 * PostToolUse plugin.
 */
export const TOKEN_MISER_CODE_MODE_TOOL_DESCRIPTION_GUIDANCE = [
  "Run independent operations concurrently with `Promise.all`. ",
  "Nested tool results remain complete inside the cell; inspect or transform ",
  "them there and emit the information needed for the next decision.",
].join("");

export function hasTokenMiserModelGuidance(
  capability: CodexServerCapabilities["codeModeOutputReducer"],
): boolean {
  const guidance = capability?.modelGuidance;
  return (
    guidance?.version === 1
    && guidance.toolDescriptionConfigKey
      === "features.code_mode.output_reducer.tool_description_guidance"
    && guidance.continuationConfigKey
      === "features.code_mode.output_reducer.continuation_guidance"
    && guidance.modelVisibleOverheadRequestField
      === "model_visible_overhead_characters"
  );
}

export const TOKEN_MISER_MANAGED_CAPABILITY_REASON =
  "Running Codex runtime lacks the complete Token Miser activation and deferred-completion capability contract.";

export function hasTokenMiserActivationTransport(
  capabilities: CodexServerCapabilities | undefined,
): boolean {
  return capabilities?.pwrdrvrTokenMiser?.version === 1;
}

export function hasManagedTokenMiserCapabilityContract(
  capabilities: CodexServerCapabilities | undefined,
): boolean {
  const deferredCompletion =
    capabilities?.codeModeOutputReducer?.deferredCompletion;
  return (
    capabilities?.pwrdrvrTokenMiser?.version === 1
    && capabilities.pwrdrvrTokenMiser.codeModeNestedPostToolUse === false
    && capabilities.codeModeOutputReducer?.protocolVersion === 1
    && capabilities.codeModeOutputReducer.intentContextVersion === 1
    && capabilities.codeModeOutputReducer.reducerRequestField
      === "parent_intent"
    && capabilities.codeModeOutputReducer.postToolUseField === "parent_intent"
    && hasTokenMiserModelGuidance(capabilities.codeModeOutputReducer)
    && deferredCompletion?.version === 1
    && deferredCompletion.terminalOnly === true
    && deferredCompletion.preservesOriginalCallId === true
    && deferredCompletion.preservesCellId === true
    && deferredCompletion.waitToolName === "wait"
  );
}

export function buildCodexTokenMiserConfig(
  reducerDescriptorPath: string,
): CodexThreadStartParams["config"] {
  return {
    features: {
      code_mode: {
        max_output_tokens_ceiling: TOKEN_MISER_MODEL_VISIBLE_CAP_TOKENS,
        output_reducer: {
          descriptor_path: reducerDescriptorPath,
          max_request_bytes: 32 * 1024 * 1024,
          max_response_bytes: TOKEN_MISER_CODE_MODE_MAX_RESPONSE_BYTES,
          // Observe every Code Mode result so the Explorer can distinguish
          // direct cells, retrievals, and reducer decisions. The local service
          // still applies the 5k-character evaluation threshold before Luna.
          min_trigger_bytes: 0,
          // The Luna request has a 45-second application timeout. Leave enough
          // room for serialization and the loopback response while staying
          // below the existing 60-second PostToolUse hook budget.
          timeout_ms: 55_000,
          tool_description_guidance:
            TOKEN_MISER_CODE_MODE_TOOL_DESCRIPTION_GUIDANCE,
        },
      },
    },
  } as CodexThreadStartParams["config"];
}

export function mergeCodexDynamicToolSpecs(
  specs: CodexDynamicToolSpec[],
): CodexDynamicToolSpec[] {
  const namespaces = new Map<
    string,
    Extract<CodexDynamicToolSpec, { type: "namespace" }>
  >();
  const functions: CodexDynamicToolSpec[] = [];

  for (const spec of specs) {
    if (spec.type !== "namespace") {
      functions.push(spec);
      continue;
    }
    const existing = namespaces.get(spec.name);
    if (existing) {
      existing.tools.push(...spec.tools);
      continue;
    }
    namespaces.set(spec.name, {
      ...spec,
      tools: [...spec.tools],
    });
  }

  return [...functions, ...namespaces.values()];
}
