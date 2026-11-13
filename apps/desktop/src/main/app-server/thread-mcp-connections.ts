import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ElicitRequestParams } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_PROJECT_TOOL_APPROVAL_CHOICE_META_KEY,
  MCP_PROJECT_TOOL_APPROVAL_OFFER_META_KEY,
  buildMcpProjectToolApprovalOffer,
  buildThreadIdentityKey,
  canIsolateMcpProviderServers,
  isAcpBackendId,
  mcpConnectionIdsForNewThread,
  mcpElicitationPurpose,
  mcpSelectionApplyTiming,
  readMcpProjectToolApprovalChoice,
  resolveMcpConnectionSetup,
  resolveMcpConnectionToolApproval,
  type AppServerBackendKind,
  type AppServerMcpElicitationResponse,
  type AppServerMcpElicitationSchema,
  type AppServerPendingRequestNotification,
  type AppServerThreadSummary,
  type DescribeThreadMcpConnectionsRequest,
  type DescribeThreadMcpConnectionsResponse,
  type ListCodexMcpServersRequest,
  type ListCodexMcpServersResponse,
  type ListThreadMcpServersRequest,
  type ListThreadMcpServersResponse,
  type McpConnectionStatus,
  type McpConnectionToolApprovalResolution,
  type MessagingDynamicToolCategory,
  type NavigationLaunchpadDraft,
  type PwrAgentMcpConnectionRequest,
  type PwrAgentMcpConnectionResponse,
  type ReadThreadMcpConnectionsRequest,
  type ReloadCodexMcpConfigRequest,
  type ReloadCodexMcpConfigResponse,
  type ReloadCodexMcpServersRequest,
  type ReloadCodexMcpServersResponse,
  type RemoveCodexMcpServerRequest,
  type RemoveCodexMcpServerResponse,
  type SetThreadMcpConnectionsRequest,
  type SetThreadMcpConnectionsResponse,
  type StartCodexMcpServerLoginRequest,
  type StartCodexMcpServerLoginResponse,
  type SubmitServerRequestRequest,
  type ThreadExecutionMode,
  type ThreadMcpConnectionReport,
  type ThreadOverlayState,
} from "@pwragent/shared";
import type { ThreadStartParams as CodexThreadStartParams } from "@pwrdrvr/codex-app-server-protocol/v2";
import { collectConcurrent } from "../../shared/concurrent-work";
import type { AcpMcpServerRegistration } from "../acp/acp-client";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { automationMcpToolAllowed, buildAutomationMcpPolicy, type AutomationMcpServer } from "../automations/automation-mcp-policy";
import { claudePlanTurnRefusal } from "../claude/claude-permissions";
import { listingDiagnostics } from "../diagnostics/listing-diagnostics";
import { getMainLogger } from "../log";
import { buildMcpToolApprovalConsent } from "../mcp-connections/mcp-approval-consent";
import type { McpConnectionBridgeRegistration } from "../mcp-connections/mcp-connection-gateway-service";
import {
  elicitationUnavailable,
  hostApprovalFormRefused,
  isUrlElicitation,
} from "../mcp-connections/mcp-elicitation-relay";
import { gatewayToolRequiresApproval, type McpGatewayInvocation, type McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";
import type { McpGatewayApproval, McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import { mcpTypes } from "../mcp-connections/mcp-sdk";
import type { ThreadRootDirectory } from "../mcp-connections/mcp-upstream-roots";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { readRecord } from "./backend-registry-notification-values";
import { acpRuntimeHasExecutionModeSelection } from "./backend-registry-notifications";
import {
  MCP_DEFAULTS_READ_BUDGET_MS,
  MCP_UPSTREAM_FORM_REQUEST_ID_PREFIX,
} from "./backend-registry-runtime-helpers";
import type {
  BackendClient,
  BackendRegistryMcpConnectionService,
  McpGatewayConversationConsent,
  McpProjectToolApprovalCardOffer,
  PendingServerRequest,
  TaskMonitorDelegationRecord,
  TaskMonitorMcpAccess,
  ThreadListCallerReason,
} from "./backend-registry-types";
import {
  buildCodexConnectionMcpConfig,
  buildCodexConnectionMcpServerName,
  mergeCodexThreadConfigs,
} from "./codex-thread-config";
import type { ForgeToolBridge } from "./forge-tool-bridge";
import { resolveThreadWorkspaceCwd } from "./linked-directory-identity";
import type { RegistryContext, RegistryHost } from "./registry-context";
import { sameMcpConnectionIds } from "./thread-launchpad-helpers";
import { acpRuntimeStateRequiresFullAccess } from "./thread-model-options";
import { buildPendingRequestKey } from "./thread-turn-keys";

// The registry's logger name, so moved log lines read as they did.
const backendRegistryLog = getMainLogger("pwragent:backend-registry");

/** A headless automation turn as the MCP gateway reads it. */
type McpHeadlessAutomationTurn = {
  agentThreadId: string;
  backend: AppServerBackendKind;
  automationName?: string;
  automationRunId: string;
  executionMode: ThreadExecutionMode;
  executionThreadId: string;
  queueEntryId: string;
  mcpConnectionIds?: string[];
  mcpGrantedConnectionIds?: string[];
  mcpServerAliases?: Record<string, string[]>;
  mcpAllowedServerNames?: string[];
  toolAllowlist?: string[];
};

/** Collaborators the composition root builds for this module. */
export interface ThreadMcpConnectionsDependencies {
  readonly forgeToolBridge: ForgeToolBridge;
}

/**
 * Registry-owned state and turn queries the MCP connection tools read. The
 * registry's construction ports satisfy it; this module never imports the
 * registry.
 */
export interface ThreadMcpConnectionsHost {
  readonly mcpConnectionService: BackendRegistryMcpConnectionService | undefined;
  readonly mcpGatewayTools: McpGatewayToolService | undefined;
  readonly codexEnvironmentCommandEnv: NodeJS.ProcessEnv | undefined;
  readonly pendingServerRequests: Map<string, PendingServerRequest>;
  readonly pendingStartedThreads: ReadonlyMap<string, AppServerThreadSummary>;
  readonly taskMonitorDelegations: ReadonlyMap<string, TaskMonitorDelegationRecord>;
  withCodexThreadClient<T>(
    threadId: string,
    operation: (client: BackendClient, mode: ThreadExecutionMode) => Promise<T>,
    requestedMode?: ThreadExecutionMode,
    logRouting?: boolean,
  ): Promise<T>;
  findThreadForWorkspaceHandoff(params: {
    backend: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    freshness?: "last-known" | "provider";
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined>;
  findHeadlessAutomationForThread(backend: AppServerBackendKind, threadId: string): McpHeadlessAutomationTurn | undefined;
  findHeadlessAutomationTurnForRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
  ): Omit<McpHeadlessAutomationTurn, "backend" | "executionThreadId"> | undefined;
  isLiveDynamicToolCall(backend: AppServerBackendKind, call: { threadId: string; turnId?: string }): boolean;
  isTaskMonitorThread(context: { backend: AppServerBackendKind; threadId: string }): boolean;
  taskMonitorForThread(context: { backend: AppServerBackendKind; threadId: string }): TaskMonitorDelegationRecord | undefined;
  resolveCodexToolCallExecutionMode(
    context: AgentToolCallContext,
    automationMode?: ThreadExecutionMode,
  ): Promise<ThreadExecutionMode | undefined>;
  resolveClaudeToolCallExecutionMode(
    threadId: string,
    automationMode?: ThreadExecutionMode,
  ): Promise<ThreadExecutionMode | undefined>;
  dynamicToolPermissionDenied(
    backend: AppServerBackendKind,
    category: MessagingDynamicToolCategory,
    call: { threadId: string; turnId?: string; tool: string; arguments?: unknown },
  ): Promise<string | null>;
}

/**
 * The MCP domain of the backend registry: registering a thread's selected
 * MCP connections with its provider, reading and changing a thread's
 * selection, the MCP gateway's approval and upstream form cards with their
 * conversation grants, the manage_mcp_connections Agent tool, and the Codex
 * MCP server settings.
 */
export class ThreadMcpConnections {
  private readonly context: RegistryContext;
  private readonly host: RegistryHost<ThreadMcpConnectionsHost>;
  private readonly forgeToolBridge: ForgeToolBridge;

  constructor(
    context: RegistryContext,
    dependencies: ThreadMcpConnectionsDependencies,
    host: RegistryHost<ThreadMcpConnectionsHost>,
  ) {
    this.context = context;
    this.host = host;
    this.forgeToolBridge = dependencies.forgeToolBridge;
  }

  // Process-local conversation grants. A source's revision also includes the
  // broker's authorization generation, so reauthorization needs fresh consent.
  private readonly mcpGatewaySessionApprovals = new Map<string, Map<string, McpGatewayConversationConsent>>();

  async prepareAutomationMcp(params: {
    client: BackendClient;
    agentThreadId: string;
    cwd?: string;
    overlay?: ThreadOverlayState;
    mcpAllowlist?: string[];
    toolAllowlist?: string[];
  }): Promise<{
    config?: CodexThreadStartParams["config"];
    connectionIds: string[];
    grantedConnectionIds: string[];
    serverAliases: Record<string, string[]>;
    allowedServerNames: string[];
    registrations: McpConnectionBridgeRegistration[];
  }> {
    const registrations: Array<{ connectionId: string; registration: McpConnectionBridgeRegistration }> = [];
    try {
      const inheritedNames = await this.readConfiguredCodexMcpServerNames(params.cwd);
      const providerEnabled = params.overlay?.mcpProviderServersEnabled !== false;
      const selectedConnectionIds = params.overlay?.mcpConnectionIds ?? [];
      // Only ids, names, and `enabled` are read here: stored config. A fresh
      // local CLI probe would hold up every run start for nothing.
      const connectionStatuses = params.mcpAllowlist?.length || selectedConnectionIds.length
        ? await this.host().mcpConnectionService?.listConnections?.({ cachedLocalStatus: true })
        : undefined;
      const namesConnection = (connection: { id: string; displayName: string }, name: string) =>
        name === connection.id || name === connection.displayName || name === connection.displayName.toLowerCase();
      // A gateway connection the automation names (Datadog, say) is granted to
      // its runs by that choice, whether or not the Agent thread selected it.
      // Only connections offered to threads qualify. A display name the Agent
      // already resolves -- its own Codex server, or another connection it
      // selected -- grants nothing, or that allowlist entry would turn
      // ambiguous and fail a run that worked before the grant existed.
      const grantedConnectionIds = (connectionStatuses ?? [])
        .filter((connection) => connection.enabled && params.mcpAllowlist?.some((entry) => {
          const name = entry.trim();
          if (name === connection.id) return true;
          return namesConnection(connection, name)
            && !(providerEnabled && inheritedNames?.includes(name))
            && !(connectionStatuses ?? []).some((other) =>
              other.id !== connection.id && selectedConnectionIds.includes(other.id) && namesConnection(other, name));
        }))
        .map((connection) => connection.id);
      const connectionIds = [...new Set([...selectedConnectionIds, ...grantedConnectionIds])];
      for (const connectionId of connectionIds) {
        for (const registration of await this.registerMcpConnections([connectionId], undefined, "codex")) {
          registrations.push({ connectionId, registration });
        }
      }
      if (inheritedNames === undefined && (params.mcpAllowlist?.length || params.toolAllowlist?.length || !providerEnabled)) {
        throw new Error("The Codex runtime cannot report configured MCP servers, so the automation's MCP allowlist cannot be applied.");
      }
      let inventory: ListThreadMcpServersResponse["servers"] = [];
      if (params.client.listMcpServers && (inheritedNames?.length || registrations.length)) {
        inventory = await params.client.listMcpServers({ threadId: params.agentThreadId, detail: "toolsAndAuthOnly" });
      }
      const bridgeRegistrations = registrations.map(({ registration }) => registration);
      const baseConfig = buildCodexConnectionMcpConfig(bridgeRegistrations, inheritedNames, { isolateFromInherited: !providerEnabled });
      const baseServers = readRecord(baseConfig?.mcp_servers) ?? {};
      const servers: AutomationMcpServer[] = (inheritedNames ?? [])
        .filter((name) => providerEnabled && readRecord(baseServers[name])?.enabled !== false)
        .map((name) => ({ name, tools: inventory.find((server) => server.name === name)?.tools }));
      for (const { connectionId, registration } of registrations) {
        const parentBridge = this.host().mcpConnectionService?.peekThreadBridge?.(connectionId, params.agentThreadId);
        const parentName = parentBridge ? buildCodexConnectionMcpServerName(parentBridge) : undefined;
        const name = buildCodexConnectionMcpServerName(registration.server);
        const displayName = connectionStatuses?.find((connection) => connection.id === connectionId)?.displayName;
        servers.push({
          name,
          aliases: [connectionId, registration.server.name, ...(parentName ? [parentName] : []), ...(displayName ? [displayName, displayName.toLowerCase()] : [])],
          connectionId,
          config: readRecord(baseServers[name]),
          tools: inventory.find((server) => server.name === parentName)?.tools,
        });
      }
      const policy = buildAutomationMcpPolicy({ servers, mcpAllowlist: params.mcpAllowlist, toolAllowlist: params.toolAllowlist });
      const selectedRegistrations = registrations.filter(({ connectionId, registration }) => {
        if (policy.connectionIds.includes(connectionId)) return true;
        registration.revoke();
        return false;
      });
      return {
        config: servers.length || baseConfig ? mergeCodexThreadConfigs(baseConfig, policy.config) : undefined,
        connectionIds: policy.connectionIds,
        grantedConnectionIds: grantedConnectionIds.filter((id) => policy.connectionIds.includes(id)),
        allowedServerNames: servers
          .filter((server) => readRecord(readRecord(policy.config?.mcp_servers)?.[server.name])?.enabled !== false)
          .flatMap((server) => [server.name, ...(server.aliases ?? [])]),
        serverAliases: Object.fromEntries(servers.filter((server) => server.connectionId).map((server) => [server.connectionId!, [server.name, ...(server.aliases ?? [])]])),
        registrations: selectedRegistrations.map(({ registration }) => registration),
      };
    } catch (error) {
      for (const { registration } of registrations) registration.revoke();
      throw error;
    }
  }

  async registerMcpConnections(
    connectionIds: string[] | undefined,
    threadId?: string,
    /** The thread's backend, so a managed local server can be given its directories. */
    backend?: AppServerBackendKind,
  ): Promise<McpConnectionBridgeRegistration[]> {
    return await listingDiagnostics.trace("workflow", { query: "mcp-registration" }, () => this.registerSelectedMcpConnections(connectionIds, threadId, backend));
  }

  private async registerSelectedMcpConnections(
    connectionIds: string[] | undefined,
    threadId?: string,
    backend?: AppServerBackendKind,
  ): Promise<McpConnectionBridgeRegistration[]> {
    const selected = [
      ...new Set(
        (connectionIds ?? []).map((connectionId) => connectionId.trim()),
      ),
    ].filter(Boolean);
    if (selected.length === 0) return [];
    const service = this.host().mcpConnectionService;
    if (!service) {
      // A selected connection with no service behind it is a runtime that
      // cannot honor the thread's setting, so the turn fails rather than
      // starting without the connection the operator chose. This used to
      // throw only for the built-in-id guard, which matches the two built-in
      // ids alone -- so every remote connection took the "unknown id"
      // branch and was dropped with a warning instead. Nothing here can
      // tell a stale id from a live one anyway: that is what the catch
      // below does, and it needs a service to do it.
      throw new Error("MCP connections are unavailable in this PwrAgent runtime.");
    }
    const registered = await collectConcurrent(selected, 4, async (connectionId) => {
      try {
        return await service.registerBridge(connectionId, threadId, undefined, backend);
      } catch (error) {
        // A connection the operator parked, removed, or locked behind the
        // gateway switch must drop out of the turn, not fail it. The
        // selection is sticky and there is no path that prunes a stale id
        // from a thread, so throwing here would brick every later turn on
        // that thread with no way to recover from inside the app.
        backendRegistryLog.warn("connection_mcp_bridge_unavailable", {
          connectionId,
          error: error instanceof Error ? error.message : String(error),
          threadId: threadId ?? null,
        });
        return undefined;
      }
    });
    const registrations = registered.filter((registration): registration is McpConnectionBridgeRegistration => registration !== undefined);
    // An ACP agent cannot be asked what it loaded, so the moment PwrAgent
    // handed the selection over is the only evidence a verification surface
    // will ever have for those backends. Record it for every backend, and
    // only once a bridge actually exists.
    if (threadId && registrations.length > 0) {
      this.host().mcpConnectionService?.noteThreadHandover?.(threadId, Date.now());
    }
    return registrations;
  }

  async readConfiguredCodexMcpServerNames(
    cwd?: string,
  ): Promise<string[] | undefined> {
    if (!this.context.providers.codex.readConfiguredMcpServerNames) {
      return undefined;
    }
    try {
      return await listingDiagnostics.trace("workflow", { query: "mcp-inventory" }, () =>
        this.context.providers.codex.readConfiguredMcpServerNames!(cwd ? { cwd } : undefined));
    } catch (error) {
      // A compatibility fallback must not prevent a selected connection from
      // starting. Without an inventory, omit disable entries rather than
      // creating a transport-less MCP config record.
      backendRegistryLog.warn("connection_mcp_config_inventory_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async registerAcpMcpConnections(
    connectionIds: string[] | undefined,
    threadId: string | undefined,
    backend: AppServerBackendKind,
  ): Promise<AcpMcpServerRegistration | undefined> {
    const registrations = await this.registerMcpConnections(
      connectionIds,
      threadId,
      backend,
    );
    if (registrations.length === 0) return undefined;
    return {
      servers: registrations.map(({ server }) => server),
      bindThread: async (nextThreadId) => {
        for (const registration of registrations) {
          registration.bindThread(nextThreadId);
        }
      },
    };
  }

  async listThreadMcpServers(
    params: ListThreadMcpServersRequest,
  ): Promise<ListThreadMcpServersResponse> {
    if (isAcpBackendId(params.backend)) {
      throw new Error("MCP inventory is only available for Codex and Claude threads");
    }
    const detail = params.detail ?? "toolsAndAuthOnly";
    if (params.backend === "claude") {
      return { ...params, detail, servers: await this.context.providers.claude.listMcpServers(params.threadId) };
    }
    const servers = await this.host().withCodexThreadClient(
      params.threadId,
      async (client) => {
        if (!client.listMcpServers) {
          throw new Error("Selected backend does not support MCP inventory");
        }
        return await client.listMcpServers({
          threadId: params.threadId,
          detail,
        });
      },
    );
    return {
      backend: params.backend,
      threadId: params.threadId,
      detail,
      servers,
    };
  }

  async reloadCodexMcpConfig(
    params: ReloadCodexMcpConfigRequest,
  ): Promise<ReloadCodexMcpConfigResponse> {
    if (isAcpBackendId(params.backend)) {
      throw new Error("MCP config reload is only available for Codex threads");
    }
    await this.host().withCodexThreadClient(params.threadId, async (client) => {
      if (!client.reloadMcpConfig) {
        throw new Error("Selected backend does not support MCP config reload");
      }
      await client.reloadMcpConfig();
    });
    return {
      backend: params.backend,
      threadId: params.threadId,
      queued: true,
    };
  }

  async listCodexMcpServers(
    params: ListCodexMcpServersRequest = {},
  ): Promise<ListCodexMcpServersResponse> {
    if (!this.context.providers.codex.listMcpServers) {
      throw new Error("Selected Codex version does not support MCP inventory");
    }
    const detail = params.detail ?? "toolsAndAuthOnly";
    const codexHome = await this.readActiveCodexMcpHome();
    return {
      codexHome,
      detail,
      servers: await this.context.providers.codex.listMcpServers({ detail }),
    };
  }

  async reloadCodexMcpServers(
    params: ReloadCodexMcpServersRequest,
  ): Promise<ReloadCodexMcpServersResponse> {
    const codexHome = await this.requireActiveCodexMcpHome(params.codexHome);
    if (!this.context.providers.codex.reloadMcpConfig) {
      throw new Error("Selected Codex version does not support MCP config reload");
    }
    await this.context.providers.codex.reloadMcpConfig();
    return { codexHome, queued: true };
  }

  async startCodexMcpServerLogin(
    params: StartCodexMcpServerLoginRequest,
  ): Promise<StartCodexMcpServerLoginResponse> {
    const codexHome = await this.requireActiveCodexMcpHome(params.codexHome);
    if (!this.context.providers.codex.startMcpServerOAuthLogin) {
      throw new Error("Selected Codex version does not support MCP login");
    }
    const result = await this.context.providers.codex.startMcpServerOAuthLogin({
      name: params.name,
    });
    return {
      codexHome,
      name: params.name,
      authorizationUrl: result.authorizationUrl,
    };
  }

  async removeCodexMcpServer(
    params: RemoveCodexMcpServerRequest,
  ): Promise<RemoveCodexMcpServerResponse> {
    const codexHome = await this.requireActiveCodexMcpHome(params.codexHome);
    if (!this.context.providers.codex.removeMcpServer) {
      throw new Error("Selected Codex version does not support MCP removal");
    }
    await this.context.providers.codex.removeMcpServer({ name: params.name });
    return { codexHome, name: params.name, removed: true };
  }

  private async readActiveCodexMcpHome(): Promise<string> {
    if (this.context.providers.codex.readCodexHome) {
      return await this.context.providers.codex.readCodexHome();
    }
    return path.resolve(
      this.host().codexEnvironmentCommandEnv?.CODEX_HOME?.trim()
      || path.join(os.homedir(), ".codex"),
    );
  }

  private async requireActiveCodexMcpHome(expectedCodexHome: string): Promise<string> {
    const activeCodexHome = await this.readActiveCodexMcpHome();
    if (path.resolve(expectedCodexHome) !== path.resolve(activeCodexHome)) {
      throw new Error(
        "Codex profile changed after this app started. Restart PwrAgent before managing MCP servers.",
      );
    }
    return activeCodexHome;
  }

  /**
   * Read a thread's saved MCP selection.
   *
   * Read on demand rather than carried on every navigation summary: the
   * selection matters only while the operator has the picker open.
   */
  async readThreadMcpConnections(
    request: ReadThreadMcpConnectionsRequest,
  ): Promise<SetThreadMcpConnectionsResponse> {
    const overlay = await this.context.stores.threads.getThreadOverlayState({
      backend: request.backend,
      threadId: request.threadId,
    });
    return {
      connectionIds: overlay?.mcpConnectionIds ?? [],
      providerServersEnabled:
        !canIsolateMcpProviderServers(request.backend)
        || overlay?.mcpProviderServersEnabled !== false,
    };
  }

  /**
   * What a thread's managed selection actually became inside the agent.
   *
   * Settings can say a connection is authorized; nothing said a given thread
   * loaded its tools, and the only surface that could — the agent's own MCP
   * inventory — names a managed connection by the hashed alias PwrAgent
   * injected it under, which appears nowhere else in the product. This joins
   * the two, so a surface can show the operator's own name and still match
   * what the agent reports.
   *
   * For a backend PwrAgent cannot interrogate, `agentInventoryAvailable` is
   * false and `handedOverAt` carries the honest remainder: what was passed
   * over, and when.
   */
  async describeThreadMcpConnections(
    request: DescribeThreadMcpConnectionsRequest,
  ): Promise<DescribeThreadMcpConnectionsResponse> {
    const selection = await this.readThreadMcpConnections(request);
    // Through the injected seam, like every other connection call here.
    // Reaching for the module singleton would leave this one method
    // unstubbable and silently outside whatever a caller injected.
    const service = this.host().mcpConnectionService;
    const statuses = (await service?.listConnections?.()) ?? [];
    const byId = new Map(statuses.map((status) => [status.id, status]));
    // Starts as "this backend can be asked" and is downgraded to what is
    // actually true: an inventory we failed to read is not one we have. The
    // renderer distinguishes "the agent did not list it" from "we could not
    // ask" on this flag, so it has to mean the latter.
    let agentInventoryAvailable = !isAcpBackendId(request.backend);
    const toolCounts = new Map<string, number>();
    if (agentInventoryAvailable && selection.connectionIds.length > 0) {
      try {
        const inventory = await this.listThreadMcpServers({
          backend: request.backend,
          threadId: request.threadId,
        });
        for (const server of inventory.servers) {
          toolCounts.set(server.name, server.tools?.length ?? 0);
        }
      } catch {
        // An older Codex build cannot report its inventory. The selection is
        // still worth showing; only the tool counts go missing.
        agentInventoryAvailable = false;
      }
    }
    const sessions = await service?.readThreadSessionStates?.(request.threadId, request.backend);
    const connections: ThreadMcpConnectionReport[] = selection.connectionIds
      .map((connectionId) => {
        const status = byId.get(connectionId);
        const serverNameInAgent = this.threadMcpServerNameInAgent(connectionId, request);
        const toolCount = serverNameInAgent
          ? toolCounts.get(serverNameInAgent)
          : undefined;
        const sessionStates = sessions?.[connectionId];
        const ended = sessionStates?.native === "ended" || sessionStates?.gateway === "ended";
        return {
          connectionId,
          displayName: status?.displayName ?? connectionId,
          ...(serverNameInAgent ? { serverNameInAgent } : {}),
          state: ended && status?.state === "ready" ? "temporarily_unavailable" : status?.state ?? "disconnected",
          configured: status?.configured ?? false,
          enabled: status?.enabled ?? false,
          ...(sessionStates ? { sessions: sessionStates } : {}),
          ...(toolCount === undefined ? {} : { toolCount }),
        } satisfies ThreadMcpConnectionReport;
      });
    const handedOverAt = service?.threadHandoverAt?.(request.threadId);
    return {
      backend: request.backend,
      threadId: request.threadId,
      connections,
      providerServersEnabled: selection.providerServersEnabled,
      appliesAt: mcpSelectionApplyTiming(request.backend),
      ...(handedOverAt === undefined ? {} : { handedOverAt }),
      agentInventoryAvailable,
    };
  }

  threadMcpServerNameInAgent(
    connectionId: string,
    context: { backend: AppServerBackendKind; threadId: string },
  ): string | undefined {
    const bridge = this.host().mcpConnectionService?.peekThreadBridge?.(connectionId, context.threadId);
    if (!bridge) return undefined;
    // ACP receives the bridge name verbatim; Codex and Claude receive the
    // hashed configuration alias. Gateway discovery has a separate session.
    return isAcpBackendId(context.backend) ? bridge.name : buildCodexConnectionMcpServerName(bridge);
  }

  /**
   * Change a live thread's MCP selection.
   *
   * Codex re-reads this overlay while starting each turn, so the change
   * reaches the agent on the operator's next message. ACP resolves MCP
   * servers only at `session/new` and `session/load`, so there the change
   * waits for the thread's next session load. Callers surface which of those
   * applies rather than reporting a bare "saved".
   */
  async setThreadMcpConnections(
    request: SetThreadMcpConnectionsRequest,
  ): Promise<SetThreadMcpConnectionsResponse> {
    const previousState = await this.context.stores.threads.getThreadOverlayState(request);
    const previousRevision = previousState?.mcpSelectionRevision;
    const reconnect = request.reconnectConnectionId;
    if (reconnect !== undefined) {
      if (typeof reconnect !== "string" || !previousState?.mcpConnectionIds?.includes(reconnect)
        || !request.connectionIds.includes(reconnect)) {
        throw new Error("Reconnect requires a local command already selected by this thread.");
      }
      const selected = new Set(previousState.mcpConnectionIds);
      if (new Set(request.connectionIds).size !== selected.size || request.connectionIds.some((id) => !selected.has(id))
        || (request.providerServersEnabled !== undefined
          && request.providerServersEnabled !== (!canIsolateMcpProviderServers(request.backend)
            || previousState.mcpProviderServersEnabled !== false))) {
        throw new Error("Change MCP access separately before reconnecting.");
      }
      const connection = (await this.host().mcpConnectionService?.listConnections?.())?.find((entry) => entry.id === reconnect);
      if (connection?.kind !== "stdio" || !connection.enabled || !connection.configured
        || !this.host().mcpConnectionService?.reconnectThreadConnection) {
        throw new Error("This thread cannot reconnect that local command.");
      }
    }
    // A backend that cannot suppress its own servers must never be left
    // holding an "off" it will ignore. The flag is sticky and its control is
    // hidden for those backends, so a value stored once — by an older build,
    // a peer, or a launchpad draft that changed provider — would otherwise
    // never be reachable again.
    // Reconnect changes only live grants and consent, with no SQLite write.
    const state = reconnect !== undefined ? previousState! : await this.context.stores.threads.setThreadMcpConnectionIds({
      backend: request.backend,
      threadId: request.threadId,
      connectionIds: request.connectionIds,
      providerServersEnabled: canIsolateMcpProviderServers(request.backend)
        ? request.providerServersEnabled
        : true,
    });
    // A changed selection or explicit reconnect revokes running calls and
    // conversation grants. Toggling the backend's own servers does neither.
    if (state.mcpSelectionRevision !== previousRevision || reconnect !== undefined) {
      this.host().mcpGatewayTools?.cancel(request.backend, request.threadId);
      this.mcpGatewaySessionApprovals.delete(JSON.stringify([request.backend, request.threadId]));
      for (const monitor of this.host().taskMonitorDelegations.values()) {
        if (monitor.monitorThreadId
          && monitor.mcpAccess?.selectionOwner.backend === request.backend
          && monitor.mcpAccess.selectionOwner.threadId === request.threadId) {
          this.host().mcpGatewayTools?.cancel(monitor.backend, monitor.monitorThreadId);
          this.mcpGatewaySessionApprovals.delete(JSON.stringify([monitor.backend, monitor.monitorThreadId]));
        }
      }
      // A connection the thread turned off keeps its grant until the agent
      // reloads its servers, but a local command started for this thread has
      // no reason to keep running in the meantime. Not awaited: stopping a
      // process can take seconds, and the operator's switch should not wait.
      const kept = new Set(state.mcpConnectionIds ?? []);
      const released = (previousState?.mcpConnectionIds ?? []).filter((id) => !kept.has(id));
      if (released.length > 0) {
        void this.host().mcpConnectionService?.closeThreadSessions?.(request.threadId, released)
          .catch((error: unknown) => {
            backendRegistryLog.warn("connection_mcp_session_release_failed", {
              error: error instanceof Error ? error.message : String(error),
              threadId: request.threadId,
            });
          });
      }
      if (reconnect !== undefined) {
        await this.host().mcpConnectionService!.reconnectThreadConnection!(reconnect, request.threadId, request.backend);
      }
    }
    const connectionIds = state.mcpConnectionIds ?? [];
    const providerServersEnabled = !canIsolateMcpProviderServers(request.backend)
      || state.mcpProviderServersEnabled !== false;
    await this.context.emit({
      backend: request.backend,
      notification: {
        method: "thread/mcpConnections/updated",
        params: {
          threadId: request.threadId,
          connectionIds,
          providerServersEnabled,
        },
      },
    });
    return { connectionIds, providerServersEnabled };
  }

  /**
   * What a new-thread draft's MCP selection should become, or undefined to
   * leave it alone.
   *
   * A draft is seeded only while nobody has chosen for it: no selection yet,
   * or one the defaults wrote themselves. A draft the operator has edited is
   * theirs, including an edit down to nothing. The seed is recomputed each
   * time rather than written once, because a draft sits open per directory
   * until it is sent, and a default changed in Settings has to reach the
   * drafts that already exist.
   *
   * Failing to read the connections, or not reading them within
   * `MCP_DEFAULTS_READ_BUDGET_MS`, leaves the draft as it is. A missing
   * default is recoverable from the MCP access panel; a failed or stalled
   * ensure is a New thread screen that will not open.
   */
  async resolveLaunchpadMcpSeed(
    existing: NavigationLaunchpadDraft | undefined,
  ): Promise<
    | Pick<
        NavigationLaunchpadDraft,
        "mcpConnectionIds" | "mcpConnectionIdsFromDefaults"
      >
    | undefined
  > {
    const seeded = existing?.mcpConnectionIdsFromDefaults === true;
    if (existing?.mcpConnectionIds !== undefined && !seeded) return undefined;
    const ids = await this.resolveNewThreadMcpConnectionIds();
    if (ids === undefined) return undefined;
    if (ids.length === 0) {
      return seeded
        ? { mcpConnectionIds: undefined, mcpConnectionIdsFromDefaults: undefined }
        : undefined;
    }
    if (seeded && sameMcpConnectionIds(existing?.mcpConnectionIds, ids)) {
      return undefined;
    }
    return { mcpConnectionIds: ids, mcpConnectionIdsFromDefaults: true };
  }

  async resolveNewThreadMcpConnectionIds(): Promise<string[] | undefined> {
    const service = this.host().mcpConnectionService;
    if (!service?.listConnections) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            `No answer within ${MCP_DEFAULTS_READ_BUDGET_MS} ms.`,
          )),
          MCP_DEFAULTS_READ_BUDGET_MS,
        );
        timer.unref?.();
      });
      return mcpConnectionIdsForNewThread(
        await Promise.race([service.listConnections({ cachedLocalStatus: true }), deadline]),
      );
    } catch (error) {
      backendRegistryLog.warn("new_thread_mcp_defaults_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The directories a managed local MCP server in this thread is given as
   * roots: each linked directory, a worktree as its own checkout rather than
   * its repository, with the thread's working directory first. A thread with
   * no linked directory has none, even when its working directory falls back
   * to something else. Only directories that exist on this machine are
   * reported.
   */
  async resolveThreadMcpRootDirectories(scope: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadRootDirectory[]> {
    const overlay = await this.context.stores.threads.getThreadOverlayState(scope);
    const summary = this.host().pendingStartedThreads.get(buildThreadIdentityKey(scope.backend, scope.threadId))
      ?? await this.host().findThreadForWorkspaceHandoff({
        ...scope,
        callerReason: "turn-cwd",
        freshness: "last-known",
      });
    const linked: ThreadRootDirectory[] = [
      ...(summary?.linkedDirectories ?? []),
      ...(overlay?.extraLinkedDirectories ?? []),
    ].map((directory) => ({
      path: directory.kind === "worktree" && directory.worktreePath
        ? directory.worktreePath
        : directory.path,
      name: directory.label,
    }));
    const cwd = resolveThreadWorkspaceCwd(summary, overlay?.extraLinkedDirectories)?.trim();
    const candidates = cwd && linked.some((directory) => directory.path === cwd)
      ? [{ path: cwd }, ...linked]
      : linked;
    const present = await Promise.all(candidates.map(async (candidate) =>
      await stat(candidate.path).then((entry) => entry.isDirectory(), () => false)));
    return candidates.filter((_candidate, index) => present[index]);
  }

  /**
   * Save the project grant an accepted card chose, then answer Codex without
   * PwrAgent's key: the choice is PwrAgent's, and Codex's grant scopes are
   * still whatever `persist` says.
   */
  async settleMcpProjectToolApprovalChoice(
    response: SubmitServerRequestRequest["response"],
    offer: McpProjectToolApprovalCardOffer | undefined,
  ): Promise<SubmitServerRequestRequest["response"]> {
    if (!response || !("action" in response)) return response;
    const meta = readRecord(response._meta);
    if (!meta || !(MCP_PROJECT_TOOL_APPROVAL_CHOICE_META_KEY in meta)) return response;
    const { [MCP_PROJECT_TOOL_APPROVAL_CHOICE_META_KEY]: _choice, ...rest } = meta;
    if (response.action === "accept" && readMcpProjectToolApprovalChoice(meta)) {
      if (offer) await this.saveMcpProjectToolApproval(offer);
      else backendRegistryLog.warn("ignoring a project grant this card did not offer");
    }
    return { ...response, _meta: Object.keys(rest).length > 0 ? rest : null };
  }

  /**
   * The operator approved the call either way, so a failed save is logged
   * and the call still runs once.
   */
  private async saveMcpProjectToolApproval(offer: McpProjectToolApprovalCardOffer): Promise<void> {
    try {
      await this.host().mcpConnectionService?.setConnectionProjectToolApproval?.(
        offer.connectionId,
        offer.repository,
        "approve",
      );
      backendRegistryLog.info("saved an MCP project tool approval from a card", {
        connectionId: offer.connectionId,
        repository: offer.repository,
      });
    } catch (error) {
      backendRegistryLog.warn("could not save an MCP project tool approval", {
        connectionId: offer.connectionId,
        repository: offer.repository,
        error: String(error),
      });
    }
  }

  /**
   * The grant a tool approval card may offer for this thread's project, or
   * none. Never for a thread without a repository, and never when the
   * project itself is set to ask before every tool: the operator already
   * chose to be asked there.
   */
  private async mcpProjectToolApprovalOffer(input: {
    connection: Pick<McpConnectionStatus, "id" | "displayName">;
    resolution: McpConnectionToolApprovalResolution;
    repository: string | undefined;
  }): Promise<McpProjectToolApprovalCardOffer | undefined> {
    const { connection, resolution, repository } = input;
    if (!repository || !this.host().mcpConnectionService?.setConnectionProjectToolApproval) return undefined;
    if (resolution.repository && resolution.toolApproval === "prompt") return undefined;
    const projectLabel = await this.forgeToolBridge.ruleRepositoryProjectLabel(repository);
    return {
      connectionId: connection.id,
      repository,
      offer: buildMcpProjectToolApprovalOffer({ serverLabel: connection.displayName, projectLabel }),
    };
  }

  async readMcpGatewaySelection(context: AgentToolCallContext): Promise<string[]> {
    const monitor = this.host().taskMonitorForThread(context);
    if (monitor) {
      const denied = await this.host().dynamicToolPermissionDenied(monitor.parentBackend, "mcp_connections", {
        threadId: monitor.parentThreadId, turnId: monitor.parentTurnId, tool: "call_mcp_tool",
      });
      if (denied) throw new Error(`The delegating messaging actor lacks permission for MCP gateway tools (${denied}).`);
      const access = monitor.mcpAccess;
      if (!access || monitor.cancellation || monitor.finalizationStarted) return [];
      const selected = await this.readThreadMcpConnections(access.selectionOwner);
      return access.connectionIds.filter((id) => selected.connectionIds.includes(id)
        || access.automation?.grantedConnectionIds?.includes(id));
    }
    const automation = this.host().findHeadlessAutomationForThread(context.backend, context.threadId);
    if (automation?.mcpConnectionIds) {
      const selected = await this.readThreadMcpConnections({ backend: context.backend, threadId: automation.agentThreadId });
      return automation.mcpConnectionIds.filter((id) => selected.connectionIds.includes(id) || automation.mcpGrantedConnectionIds?.includes(id));
    }
    return (await this.readThreadMcpConnections(context)).connectionIds;
  }

  async taskMonitorMcpAccess(context: AgentToolCallContext): Promise<TaskMonitorMcpAccess> {
    const inherited = this.host().taskMonitorForThread(context)?.mcpAccess;
    const automation = this.host().findHeadlessAutomationForThread(context.backend, context.threadId);
    return {
      connectionIds: await this.readMcpGatewaySelection(context),
      selectionOwner: inherited?.selectionOwner ?? { backend: context.backend, threadId: automation?.agentThreadId ?? context.threadId },
      ...(inherited?.automation || automation ? {
        automation: inherited?.automation ?? {
          grantedConnectionIds: automation?.mcpGrantedConnectionIds?.slice(),
          serverAliases: automation?.mcpServerAliases ? structuredClone(automation.mcpServerAliases) : undefined,
          toolAllowlist: automation?.toolAllowlist?.slice(),
        },
      } : {}),
    };
  }

  async approveGatewayInvocation(
    invocation: McpGatewayInvocation,
    context: AgentToolCallContext,
    signal: AbortSignal,
    annotations?: McpGatewayTool["definition"]["annotations"],
    catalogRevision?: string,
    consentRevision?: string,
  ): Promise<McpGatewayApproval> {
    signal.throwIfAborted();
    const requestId = `mcp-gateway:${randomUUID()}`;
    const sourceRevision = consentRevision ?? invocation.schemaRevision;
    const sourceKey = JSON.stringify([invocation.connectionId, invocation.serverName, invocation.toolName]);
    const monitor = this.host().taskMonitorForThread(context);
    const readOnlyCall = annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
    if (monitor && !readOnlyCall) return false;
    // Claude passes plan-turn gateway calls here without its generic card.
    // The upstream hints decide whether the call can run in a read-only turn.
    if (!readOnlyCall && context.backend === "claude"
      && this.context.providers.claude.livePermissionMode(context.threadId) === "plan") {
      throw new Error(claudePlanTurnRefusal(`"${invocation.toolName}" on ${invocation.serverName}`));
    }
    const selectionOwner = monitor?.mcpAccess?.selectionOwner ?? context;
    const approvalContext = monitor
      ? { backend: monitor.parentBackend, threadId: monitor.parentThreadId, turnId: monitor.parentTurnId }
      : context;
    const sessionKey = JSON.stringify([approvalContext.backend, approvalContext.threadId]);
    const selectionRevision = (await this.context.stores.threads.getThreadOverlayState(selectionOwner))?.mcpSelectionRevision;
    const denialKey = JSON.stringify([sourceKey, invocation.schemaRevision, selectionRevision]);
    if (monitor?.deniedMcpTools?.has(denialKey)) return false;
    signal.throwIfAborted();
    const approvals = this.mcpGatewaySessionApprovals.get(sessionKey) ?? new Map<string, McpGatewayConversationConsent>();
    let current = approvals.get(sourceKey);
    // Observe revocation before automatic approval as well. Identity changes
    // supersede pending responses, even when a catalog later restores R1.
    if (!current || current.schemaRevision !== sourceRevision
      || current.selectionRevision !== selectionRevision) {
      current = { schemaRevision: sourceRevision, selectionRevision, approved: false };
      approvals.set(sourceKey, current);
      this.mcpGatewaySessionApprovals.set(sessionKey, approvals);
    }
    const consent = current;
    const serverKey = JSON.stringify([invocation.connectionId, invocation.serverName]);
    let serverConsent = approvals.get(serverKey);
    if (catalogRevision && (!serverConsent || serverConsent.schemaRevision !== catalogRevision
      || serverConsent.selectionRevision !== selectionRevision)) {
      serverConsent = { schemaRevision: catalogRevision, selectionRevision, approved: false };
      approvals.set(serverKey, serverConsent);
    }
    // A connection grant is offered only for a catalog read from the owner,
    // never a revision supplied in the agent's tool arguments.
    const connectionConsent = catalogRevision ? serverConsent : undefined;
    const notification: AppServerPendingRequestNotification = {
      method: "mcpServer/elicitation/request",
      params: {
        threadId: approvalContext.threadId,
        turnId: approvalContext.turnId,
        requestId,
        serverName: invocation.serverName,
        mode: "form",
        message: `Allow the agent to call "${invocation.toolName}" on ${invocation.serverName}?`,
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          pwragent_approval_kind: "mcp_tool_call",
          persist: connectionConsent ? ["session", "server-session"] : ["session"],
          subtitle: monitor
            ? `Allow this read-only tool or read-only ${invocation.serverName} tools in this conversation. Job Monitor approval never permits mutating calls. Approval ends when PwrAgent restarts, MCP access changes, or the approved tools change.`
            : connectionConsent
            ? `Allow this tool or all ${invocation.serverName} tools in this conversation, with any arguments. Approval ends when PwrAgent restarts, MCP access changes, or the approved tools change.`
            : "Allow this tool in this conversation, with any arguments. Approval ends when PwrAgent restarts, MCP access changes, or the tool changes.",
          // The same rows Codex sends, so desktop and messaging draw and
          // redact the arguments one way.
          tool_params_display: Object.entries(invocation.arguments).map(([name, value]) => ({
            name,
            value: typeof value === "string" ? value : JSON.stringify(value),
          })),
        },
      },
    };
    // This is a host-owned invocation approval, not upstream MCP elicitation.
    // Full Access already authorizes it; ordinary forms and URL flows still
    // pass through performServerRequest and remain interactive.
    const monitorAutomation = monitor?.mcpAccess?.automation;
    if (monitorAutomation) {
      return Boolean(monitor?.mcpAccess?.connectionIds.includes(invocation.connectionId)
        && automationMcpToolAllowed(monitorAutomation.toolAllowlist,
          [invocation.serverName, invocation.connectionId, ...(monitorAutomation.serverAliases?.[invocation.connectionId] ?? [])], invocation.toolName));
    }
    const automation = this.host().findHeadlessAutomationTurnForRequest(context.backend, notification);
    if (automation?.mcpConnectionIds) {
      if (!automation.mcpConnectionIds.includes(invocation.connectionId)
        || !automationMcpToolAllowed(automation.toolAllowlist, [invocation.serverName, invocation.connectionId, ...(automation.mcpServerAliases?.[invocation.connectionId] ?? [])], invocation.toolName)) {
        return false;
      }
      signal.throwIfAborted();
      return true;
    }
    if (await this.isMcpGatewayFullAccess(context, automation?.executionMode)) {
      signal.throwIfAborted();
      backendRegistryLog.info("auto-approving Full Access MCP gateway invocation", {
        backend: context.backend,
        threadId: context.threadId,
        turnId: context.turnId,
        connectionId: invocation.connectionId,
        serverName: invocation.serverName,
        toolName: invocation.toolName,
      });
      return true;
    }
    // Codex auto_review has no client API for reviewing host-owned dynamic
    // calls. Keep scoped confirmation until that integration is available.
    if (automation) return false;
    signal.throwIfAborted();
    // The connection's Tool approval setting, read now so the next call
    // follows a change. By default Codex's rule applies: listing and
    // inspecting run, and a restart still asks.
    // A project's own mode wins for a thread in that project.
    const repository = await this.forgeToolBridge.threadProjectRepository(approvalContext.backend, approvalContext.threadId);
    const { resolution, connection: approvalConnection } =
      await this.readMcpConnectionToolApproval(invocation.connectionId, repository);
    const toolApproval = resolution.toolApproval;
    signal.throwIfAborted();
    if (!gatewayToolRequiresApproval(annotations, toolApproval)) {
      backendRegistryLog.info("running MCP gateway tool without approval", {
        backend: context.backend,
        threadId: context.threadId,
        turnId: context.turnId,
        connectionId: invocation.connectionId,
        serverName: invocation.serverName,
        toolName: invocation.toolName,
        toolApproval,
        ...(resolution.repository ? { repository: resolution.repository } : {}),
      });
      return true;
    }
    if ((consent.approved && (!consent.readOnlyOnly || readOnlyCall))
      || (connectionConsent?.approved && (!connectionConsent.readOnlyOnly || readOnlyCall))) return true;
    // A Job Monitor's card approves reads only, so it offers no grant.
    const projectOffer = !monitor && approvalConnection
      ? await this.mcpProjectToolApprovalOffer({ connection: approvalConnection, resolution, repository })
      : undefined;
    signal.throwIfAborted();
    if (projectOffer) {
      notification.params._meta = {
        ...readRecord(notification.params._meta),
        [MCP_PROJECT_TOOL_APPROVAL_OFFER_META_KEY]: projectOffer.offer,
      };
    }
    const key = buildPendingRequestKey({ ...approvalContext, requestId });
    return await new Promise<McpGatewayApproval>((resolve, reject) => {
      if (monitor) monitor.pendingMcpApprovalCount = (monitor.pendingMcpApprovalCount ?? 0) + 1;
      let waiting = true;
      const finish = (approved: McpGatewayApproval, error?: unknown): void => {
        if (!waiting) return;
        waiting = false;
        if (monitor) {
          monitor.pendingMcpApprovalCount = Math.max(0, (monitor.pendingMcpApprovalCount ?? 0) - 1);
          monitor.lastActivityAt = Date.now();
        }
        signal.removeEventListener("abort", aborted);
        this.host().pendingServerRequests.delete(key);
        if (error) reject(error);
        else resolve(approved);
      };
      const aborted = (): void => {
        finish(false, signal.reason);
        void this.context.emit({ backend: approvalContext.backend, notification: {
          method: "serverRequest/resolved", params: { threadId: approvalContext.threadId, turnId: approvalContext.turnId, requestId },
        } }).catch(() => undefined);
      };
      this.host().pendingServerRequests.set(key, {
        backend: approvalContext.backend, notification,
        ...(monitor ? { owner: { backend: context.backend, threadId: context.threadId, turnId: context.turnId } } : {}),
        resolve: (response) => {
          if (signal.aborted) { aborted(); return; }
          const approved = Boolean(response && "action" in response && response.action === "accept");
          if (response && "action" in response && response.action === "decline" && monitor) (monitor.deniedMcpTools ??= new Set()).add(denialKey);
          const responseMeta = response && "_meta" in response ? readRecord(response._meta) : undefined;
          if (approved && readMcpProjectToolApprovalChoice(responseMeta)) {
            if (!projectOffer) {
              backendRegistryLog.warn("ignoring a project grant this card did not offer", { threadId: context.threadId, requestId });
              finish(true);
              return;
            }
            void this.saveMcpProjectToolApproval(projectOffer).finally(() => finish(true));
            return;
          }
          const persist = responseMeta?.persist;
          const rememberedConsent = persist === "session" ? consent
            : persist === "server-session" ? connectionConsent : undefined;
          const rememberedKey = persist === "server-session" ? serverKey : sourceKey;
          if (approved && rememberedConsent) {
            finish({ onInvoked: async () => {
              // A late response is provisional until the owner accepts its
              // exact schema/auth revision. Peer-instance edits also revoke it.
              if (signal.aborted || this.context.lifecycle.closed) return;
              try {
                const latest = await this.context.stores.threads.getThreadOverlayState(selectionOwner);
                if (!signal.aborted && !this.context.lifecycle.closed
                  && latest?.mcpSelectionRevision === selectionRevision
                  && this.mcpGatewaySessionApprovals.get(sessionKey)?.get(rememberedKey) === rememberedConsent) {
                  if (!monitor) rememberedConsent.readOnlyOnly = false;
                  else if (!rememberedConsent.approved) rememberedConsent.readOnlyOnly = true;
                  rememberedConsent.approved = true;
                }
              } catch (error) {
                backendRegistryLog.warn("could not record MCP conversation approval", { error: String(error) });
              }
            } });
            return;
          }
          finish(approved);
        },
        reject: (error) => finish(false, error),
      });
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      void this.context.emit({ backend: approvalContext.backend, notification }).catch((error) => finish(false, error));
    });
  }

  /**
   * Show a form or link that an upstream MCP server sends while a gateway
   * call runs, on the calling thread's card, and return the person's answer.
   * A link is drawn with its host and full address, and opens only when the
   * person chooses Open in browser; its acceptance carries no content.
   *
   * This is not invocation approval. Full Access, the connection's tool
   * approval policy and conversation grants never answer it, and nothing is
   * remembered from it: the next form asks again. The message, requested
   * schema and `_meta` reach the card exactly as the server sent them. A Job
   * Monitor or headless automation has no one to ask, so the form fails
   * closed there; so does a turn that is no longer live.
   */
  async requestUpstreamMcpForm(
    request: ElicitRequestParams,
    invocation: McpGatewayInvocation,
    context: AgentToolCallContext,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    await mcpTypes.load();
    if (this.host().isTaskMonitorThread(context)) {
      throw elicitationUnavailable("A Job Monitor cannot answer an MCP server's form.");
    }
    const link = isUrlElicitation(request)
      ? request as { url: string; elicitationId: string }
      : undefined;
    const requestedSchema = link
      ? undefined
      : (request as { requestedSchema?: AppServerMcpElicitationSchema }).requestedSchema;
    const _meta = request._meta ?? null;
    // A card drawn as a host tool approval offers a grant to keep. Besides the
    // `_meta` keys the relay refuses, an empty browser form with an origin
    // draws as one; a server's own form must never be shown as one.
    if (!link && mcpElicitationPurpose({ mode: "form", serverName: invocation.serverName, _meta, requestedSchema }) === "tool-approval") {
      throw hostApprovalFormRefused();
    }
    const requestId = `${MCP_UPSTREAM_FORM_REQUEST_ID_PREFIX}${randomUUID()}`;
    const notification: AppServerPendingRequestNotification = {
      method: "mcpServer/elicitation/request",
      params: {
        threadId: context.threadId,
        turnId: context.turnId,
        requestId,
        serverName: invocation.serverName,
        message: request.message,
        ...(link
          ? { mode: "url" as const, url: link.url, elicitationId: link.elicitationId }
          : { mode: "form" as const, requestedSchema }),
        _meta,
      },
    };
    if (this.host().findHeadlessAutomationTurnForRequest(context.backend, notification)) {
      throw elicitationUnavailable("A headless automation run has no one to answer an MCP server's form.");
    }
    if (!this.host().isLiveDynamicToolCall(context.backend, context)) {
      throw elicitationUnavailable("The turn that made this call has ended.");
    }
    const key = buildPendingRequestKey({ backend: context.backend, threadId: context.threadId, requestId });
    return await new Promise<unknown>((resolve, reject) => {
      let waiting = true;
      const finish = (): boolean => {
        if (!waiting) return false;
        waiting = false;
        signal.removeEventListener("abort", withdraw);
        if (this.host().pendingServerRequests.get(key)?.notification === notification) {
          this.host().pendingServerRequests.delete(key);
        }
        return true;
      };
      // The call ended first: take the card down and answer nothing.
      const withdraw = (): void => {
        if (!finish()) return;
        reject(signal.reason ?? new DOMException("The MCP form was withdrawn.", "AbortError"));
        void this.context.emit({ backend: context.backend, notification: {
          method: "serverRequest/resolved",
          params: { threadId: context.threadId, turnId: context.turnId, requestId },
        } }).catch(() => undefined);
      };
      this.host().pendingServerRequests.set(key, {
        backend: context.backend,
        notification,
        resolve: (response) => {
          if (signal.aborted) {
            withdraw();
            return;
          }
          if (finish()) resolve(response);
        },
        reject: (error) => {
          if (finish()) reject(error);
        },
      });
      signal.addEventListener("abort", withdraw, { once: true });
      if (signal.aborted) {
        withdraw();
        return;
      }
      void this.context.emit({ backend: context.backend, notification }).catch((error) => {
        if (finish()) reject(error);
      });
    });
  }

  /**
   * Codex's own approval card for a tool on a selected connection. Answers
   * it when the connection, or the thread's project, is set to Allow all
   * tools; otherwise names the project grant the card may offer.
   */
  async selectedConnectionMcpConsent(
    request: AppServerPendingRequestNotification,
    signal?: AbortSignal,
  ): Promise<{
    consent?: AppServerMcpElicitationResponse;
    projectOffer?: McpProjectToolApprovalCardOffer;
  } | undefined> {
    const consent = buildMcpToolApprovalConsent(request);
    const threadId = request.params.threadId;
    const turnId = request.params.turnId ?? undefined;
    const service = this.host().mcpConnectionService;
    if (!consent || !service?.peekThreadBridge || !service.listConnections
      || !this.host().isLiveDynamicToolCall("codex", { threadId, turnId })) return undefined;
    try {
      signal?.throwIfAborted();
      const selected = await this.readThreadMcpConnections({ backend: "codex", threadId });
      const connectionId = selected.connectionIds.find((id) => {
        const bridge = service.peekThreadBridge!(id, threadId);
        return bridge && buildCodexConnectionMcpServerName(bridge) === request.params.serverName;
      });
      if (!connectionId) return undefined;
      const connection = (await service.listConnections({ cachedLocalStatus: true }))
        .find((entry) => entry.id === connectionId);
      if (!connection?.enabled || !connection.configured
        || connection.state === "disconnected" || connection.state === "reauthorization_required") return undefined;
      const repository = await this.forgeToolBridge.threadProjectRepository("codex", threadId);
      const resolution = resolveMcpConnectionToolApproval(connection, repository);
      if (resolution.toolApproval !== "approve") {
        if (this.host().isTaskMonitorThread({ backend: "codex", threadId })) return undefined;
        const projectOffer = await this.mcpProjectToolApprovalOffer({ connection, resolution, repository });
        signal?.throwIfAborted();
        return projectOffer ? { projectOffer } : undefined;
      }
      // A server prefix is not proof of ownership. Recheck selection, the
      // exact live bridge and turn after asynchronous policy reads.
      const current = await this.readThreadMcpConnections({ backend: "codex", threadId });
      signal?.throwIfAborted();
      const currentBridge = service.peekThreadBridge(connectionId, threadId);
      if (!current.connectionIds.includes(connectionId)
        || !this.host().isLiveDynamicToolCall("codex", { threadId, turnId })
        || !currentBridge || buildCodexConnectionMcpServerName(currentBridge) !== request.params.serverName) return undefined;
      if (resolution.repository) {
        backendRegistryLog.info("approving MCP tool call allowed for its project", {
          threadId, turnId, connectionId, repository: resolution.repository,
        });
      }
      // One invocation only: future requests must reread the connection's
      // policy rather than inherit a Codex conversation or permanent grant.
      return { consent };
    } catch {
      signal?.throwIfAborted();
      // An unavailable policy or registration keeps the normal prompt.
    }
    return undefined;
  }

  // A lookup that fails reads as the default, which still asks for anything
  // the server does not mark safe; it never reads as Allow all tools.
  private async readMcpConnectionToolApproval(
    connectionId: string,
    repository?: string,
  ): Promise<{ resolution: McpConnectionToolApprovalResolution; connection?: McpConnectionStatus }> {
    try {
      // The approval mode is stored config. Reading it must not wait on a
      // local CLI's status probe before every tool call.
      const connections = await this.host().mcpConnectionService?.listConnections?.({ cachedLocalStatus: true });
      const connection = connections?.find((entry) => entry.id === connectionId);
      return {
        resolution: connection ? resolveMcpConnectionToolApproval(connection, repository) : { toolApproval: "auto" },
        ...(connection ? { connection } : {}),
      };
    } catch (error) {
      backendRegistryLog.warn("could not read MCP connection tool approval", { connectionId, error: String(error) });
      return { resolution: { toolApproval: "auto" } };
    }
  }

  async isMcpGatewayFullAccess(
    context: AgentToolCallContext,
    automationMode?: ThreadExecutionMode,
  ): Promise<boolean> {
    if (context.backend === "codex") {
      return await this.host().resolveCodexToolCallExecutionMode(context, automationMode) === "full-access";
    }
    // Bypass permissions is Claude's Full Access. Claude asks nothing under
    // it, so the gateway card would be the only prompt.
    if (context.backend === "claude") {
      return await this.host().resolveClaudeToolCallExecutionMode(context.threadId, automationMode) === "full-access";
    }
    if (isAcpBackendId(context.backend)) {
      const session = this.context.providers.acp.getSession(context.backend, context.threadId);
      const runtimeCapabilities = this.context.providers.acp.getInstalledAgent(context.backend)?.runtimeCapabilities;
      // Match ACP permission approvals: a runtime selector is authoritative
      // over a stale session executionMode value.
      return acpRuntimeHasExecutionModeSelection({
        registryId: this.context.providers.acp.getInstalledAgent(context.backend)?.registryId,
        runtime: session?.acpRuntime,
        runtimeCapabilities,
      })
        ? acpRuntimeStateRequiresFullAccess({ runtime: session?.acpRuntime, runtimeCapabilities })
        : session?.executionMode === "full-access";
    }
    return false;
  }

  /**
   * Back the `manage_mcp_connections` agent tool.
   *
   * The split here is deliberate and is the whole safety story: an agent may
   * read the registry and propose an addition to it, while authorizing,
   * enabling and removing stay with a person in Settings. `create` writes an
   * inert record — it reaches no network and mints no bridge grant — so the
   * worst a prompt injection can achieve is a row an operator has to look at
   * and consent to before anything can use it.
   */
  async handleAgentMcpConnectionRequest(
    request: PwrAgentMcpConnectionRequest,
  ): Promise<PwrAgentMcpConnectionResponse> {
    const service = this.host().mcpConnectionService;
    if (
      !service?.listConnections
      || !service.createConnection
      || !service.probeConnection
    ) {
      return {
        ok: false,
        error: {
          code: "unsupported_operation",
          message: "MCP connections are unavailable in this PwrAgent runtime.",
        },
      };
    }
    try {
      if (request.args.action === "list") {
        const gatewayEnabled = this.readMcpGatewayEnabled();
        const statuses = await service.listConnections();
        return {
          ok: true,
          data: {
            action: "list",
            gatewayEnabled,
            connections: statuses.map((connection) => {
              const setup = resolveMcpConnectionSetup({
                connection,
                gatewayEnabled,
              });
              return {
                id: connection.id,
                displayName: connection.displayName,
                serverUrl: connection.serverUrl,
                kind: connection.kind,
                authMode: connection.authMode,
                state: connection.state,
                setupState: setup.state,
                setupDetail: setup.detail,
                configured: connection.configured,
                enabled: connection.enabled,
                threadSelectable: setup.threadSelectable,
              };
            }),
          },
        };
      }
      if (request.args.action === "create") {
        // Probed before it is written, exactly as the Settings form does, so
        // an agent gets the same actionable answer rather than a saved row
        // and an OAuth discovery failure.
        const probe = await service.probeConnection({
          serverUrl: request.args.serverUrl,
        });
        if (!probe.ok) {
          return {
            ok: false,
            error: { code: "invalid_arguments", message: probe.message },
          };
        }
        const connection = await service.createConnection({
          displayName: request.args.displayName,
          serverUrl: probe.serverUrl,
        });
        const setup = resolveMcpConnectionSetup({
          connection,
          gatewayEnabled: this.readMcpGatewayEnabled(),
        });
        return {
          ok: true,
          data: {
            action: "create",
            id: connection.id,
            displayName: connection.displayName,
            serverUrl: connection.serverUrl,
            setupState: setup.state,
            nextStep:
              `Registered, but not yet usable. A person has to authorize ${connection.displayName} in Settings → Plugins; PwrAgent cannot complete the OAuth consent on its own. After that it can be selected per thread under MCP access.`,
          },
        };
      }
      const threadId = request.args.threadId ?? request.context.threadId;
      if (!threadId) {
        return {
          ok: false,
          error: {
            code: "invalid_arguments",
            message: "Pass threadId, or call this from inside a thread.",
          },
        };
      }
      return {
        ok: true,
        data: {
          action: "describe_thread",
          ...(await this.describeThreadMcpConnections({
            backend: request.context.backend,
            threadId,
          })),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private readMcpGatewayEnabled(): boolean {
    try {
      return getDesktopSettingsService().resolveMcpGatewayEnabled();
    } catch {
      // The gateway defaults on, and a settings read failure is not evidence
      // that an operator turned it off.
      return true;
    }
  }

  /** Forgets every conversation grant; the registry calls this as it closes. */
  clearSessionApprovals(): void {
    this.mcpGatewaySessionApprovals.clear();
  }
}
