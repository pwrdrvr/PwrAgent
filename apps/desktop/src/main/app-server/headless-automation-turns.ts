import { extractFirstMeaningfulTextInput } from "@pwragent/owner-core/thread-title-lifecycle";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerBackendKind,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerTurnInputItem,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { buildMcpGatewayToolDefinitions } from "../agent-tools/pwragent-mcp-gateway-tools";
import { getMainLogger } from "../log";
import type { McpConnectionBridgeRegistration } from "../mcp-connections/mcp-connection-gateway-service";
import type { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import { getOwnerHostServices } from "../owner-host";
import { assertOwnerExecutionPolicy } from "../owner-runtime-policy";
import {
  errorMessageFromTerminalNotification,
  finalTextFromTerminalNotification,
  prependAutomationRuntimeContext,
  turnIdFromTerminalNotification,
} from "./backend-registry-notifications";
import type { BackendClient } from "./backend-registry-types";
import { executionModeSettings } from "./execution-mode-settings";
import type { RegistryContext, RegistryHost } from "./registry-context";
import type { RegistryHostPorts } from "./registry-host-ports";
import type { ThreadMcpConnections } from "./thread-mcp-connections";
import { buildHeadlessAutomationTurnKey } from "./thread-turn-keys";

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

export type HeadlessAutomationTurnsHost = Pick<RegistryHostPorts,
  "admitNewThreadModelSettings" | "assertNotBootstrap" | "assertThreadOwnership" | "getCachedThreadSummary" | "getClient"
  | "resolveThreadEnvironmentCwd" | "withArchiveWorkspaceWrite"
>;

type HeadlessAutomationTurn = {
  agentThreadId: string;
  backend: AppServerBackendKind;
  automationName?: string;
  automationRunId: string;
  executionMode: ThreadExecutionMode;
  executionThreadId: string;
  queueEntryId: string;
  startedAt: number;
  suppressBindingBroadcast?: boolean;
  mcpConnectionIds?: string[];
  /** Connections the automation's own allowlist granted, not the Agent's selection. */
  mcpGrantedConnectionIds?: string[];
  mcpServerAliases?: Record<string, string[]>;
  mcpAllowedServerNames?: string[];
  toolAllowlist?: string[];
  mcpRegistrations?: McpConnectionBridgeRegistration[];
  pendingTerminalNotification?: AppServerNotification;
};

/** Owns ephemeral automation turn admission, lifecycle and per-run MCP grants. */
export class HeadlessAutomationTurns {
  private readonly headlessAutomationTurns = new Map<string, HeadlessAutomationTurn>();

  constructor(
    private readonly context: Pick<RegistryContext, "emit"> & {
      readonly stores: { readonly threads: Pick<RegistryContext["stores"]["threads"], "getThreadOverlayState"> };
    },
    private readonly threadMcpConnections: Pick<ThreadMcpConnections, "prepareAutomationMcp">,
    private readonly mcpGatewayTools: McpGatewayToolService | undefined,
    private readonly host: RegistryHost<HeadlessAutomationTurnsHost>,
  ) {}

  runningTurns(): Iterable<Readonly<Pick<HeadlessAutomationTurn,
    "agentThreadId" | "automationName" | "automationRunId" | "backend" | "executionThreadId" | "startedAt"
  >>> {
    return this.headlessAutomationTurns.values();
  }

  revokeRegistrations(): void {
    for (const run of this.headlessAutomationTurns.values()) {
      for (const registration of run.mcpRegistrations ?? []) registration.revoke();
    }
  }

  async startAutomationHeadlessTurn(params: {
    backend: AppServerBackendKind;
    agentThreadId: string;
    automationName?: string;
    automationRunId: string;
    cwd?: string;
    executionMode?: ThreadExecutionMode;
    fastMode?: boolean;
    input: AppServerTurnInputItem[];
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    mcpAllowlist?: string[];
    toolAllowlist?: string[];
    suppressBindingBroadcast?: boolean;
  }): Promise<{
    backend: AppServerBackendKind;
    headlessThreadId: string;
    queueEntryId: string;
    threadId: string;
    turnId: string;
  }> {
    assertOwnerExecutionPolicy(getOwnerHostServices().runtimePolicy, params);
    this.host().assertNotBootstrap("startAutomationHeadlessTurn");
    this.host().assertThreadOwnership();
    const overlay = await this.context.stores.threads.getThreadOverlayState({
      backend: params.backend,
      threadId: params.agentThreadId,
    });
    const executionMode = params.executionMode ?? overlay?.executionMode ?? "default";
    const modeSettings = executionModeSettings(executionMode);
    // An automation turn has nobody watching it, so only Auto asks, and only
    // while the operator lets anything ask.
    const approvalPolicy = getOwnerHostServices().runtimePolicy?.approvals === "never" || executionMode !== "auto"
      ? "never"
      : "on-request";
    const sandbox = modeSettings.sandbox;
    const modelSettings = await this.host().admitNewThreadModelSettings(params.backend, {
      model: params.model ?? overlay?.model,
      serviceTier: params.serviceTier ?? overlay?.serviceTier,
      reasoningEffort: params.reasoningEffort ?? overlay?.reasoningEffort,
      fastMode:
        params.backend === "codex"
          ? params.fastMode ?? overlay?.fastMode
          : undefined,
    });
    const cwd =
      params.cwd ??
      (params.backend === "codex"
        ? await this.host().resolveThreadEnvironmentCwd(
            params.backend,
            params.agentThreadId,
            overlay,
          )
        : undefined);
    const input = prependAutomationRuntimeContext({
      approvalPolicy,
      executionMode,
      input: params.input,
      label: modeSettings.label,
      sandbox,
    });
    const client = this.host().getClient(params.backend, executionMode);
    const mcp = params.backend === "codex"
      ? await this.threadMcpConnections.prepareAutomationMcp({ client, agentThreadId: params.agentThreadId, cwd, overlay, mcpAllowlist: params.mcpAllowlist, toolAllowlist: params.toolAllowlist })
      : undefined;
    if (params.backend !== "codex" && (params.mcpAllowlist?.length || params.toolAllowlist?.length)) {
      throw new Error("Automation MCP allowlists currently require the Codex backend.");
    }
    const submittedPrompt = extractFirstMeaningfulTextInput(params.input);
    backendRegistryLog.info("starting automation headless thread", {
      agentThreadId: params.agentThreadId,
      automationName: params.automationName,
      automationRunId: params.automationRunId,
      approvalPolicy,
      backend: params.backend,
      cwd,
      executionMode,
      ephemeral: params.backend === "codex",
      inputItemCount: input.length,
      promptLength: submittedPrompt?.length ?? 0,
      sandbox,
    });
    let headlessThread: { threadId: string };
    try {
      headlessThread = await this.host().withArchiveWorkspaceWrite(cwd ? [cwd] : [], async () => await client.startThread({
        ...(cwd ? { cwd } : {}),
        ...modelSettings,
        approvalPolicy,
        approvalsReviewer: modeSettings.approvalsReviewer,
        ephemeral: params.backend === "codex" ? true : undefined,
        sandbox,
        ...(mcp?.config ? { config: mcp.config } : {}),
        ...(mcp?.connectionIds.length ? { dynamicTools: new AgentToolRouter(buildMcpGatewayToolDefinitions(this.mcpGatewayTools)).buildDynamicToolSpecs() } : {}),
      }));
    } catch (error) {
      for (const registration of mcp?.registrations ?? []) registration.revoke();
      throw error;
    }
    backendRegistryLog.info("automation headless thread created", {
      agentThreadId: params.agentThreadId,
      automationName: params.automationName,
      automationRunId: params.automationRunId,
      backend: params.backend,
      executionMode,
      headlessThreadId: headlessThread.threadId,
    });
    const queueEntryId = `headless:${params.automationRunId}`;
    const pendingKey = buildHeadlessAutomationTurnKey(params.backend, headlessThread.threadId, "");
    const record = {
      agentThreadId: params.agentThreadId,
      backend: params.backend,
      automationName: params.automationName,
      automationRunId: params.automationRunId,
      executionMode,
      executionThreadId: headlessThread.threadId,
      queueEntryId,
      startedAt: Date.now(),
      suppressBindingBroadcast: params.suppressBindingBroadcast,
      mcpConnectionIds: mcp?.connectionIds,
      mcpGrantedConnectionIds: mcp?.grantedConnectionIds,
      mcpServerAliases: mcp?.serverAliases,
      mcpAllowedServerNames: mcp?.allowedServerNames,
      toolAllowlist: params.toolAllowlist,
      mcpRegistrations: mcp?.registrations,
      pendingTerminalNotification: undefined as AppServerNotification | undefined,
    };
    // Tool calls can arrive before turn/start returns. Install the scoped
    // authorization before allowing the runtime to execute any tools.
    this.headlessAutomationTurns.set(pendingKey, record);
    for (const registration of mcp?.registrations ?? []) registration.bindThread(headlessThread.threadId);
    let turn: Awaited<ReturnType<BackendClient["startTurn"]>>;
    try {
      turn = await client.startTurn({
        threadId: headlessThread.threadId,
        input,
        ...(cwd ? { cwd } : {}),
        ...modelSettings,
        approvalPolicy,
        approvalsReviewer: modeSettings.approvalsReviewer,
        sandbox,
      });
    } catch (error) {
      this.headlessAutomationTurns.delete(pendingKey);
      for (const registration of mcp?.registrations ?? []) registration.revoke();
      throw error;
    }
    backendRegistryLog.info("automation headless turn started", {
      agentThreadId: params.agentThreadId,
      automationName: params.automationName,
      automationRunId: params.automationRunId,
      approvalPolicy,
      backend: params.backend,
      executionMode,
      headlessThreadId: turn.threadId,
      queueEntryId,
      sandbox,
      turnId: turn.turnId,
    });
    if (this.headlessAutomationTurns.delete(pendingKey)) {
      this.headlessAutomationTurns.set(buildHeadlessAutomationTurnKey(params.backend, turn.threadId, turn.turnId), record);
    }
    await this.context.emit({
      backend: params.backend,
      notification: {
        method: "thread/turnQueue/updated",
        params: {
          threadId: params.agentThreadId,
          queueEntryId,
          origin: "automation",
          automationRunId: params.automationRunId,
          automationName: params.automationName,
          status: "started",
          backendThreadId: turn.threadId,
          turnId: turn.turnId,
          suppressBindingBroadcast: params.suppressBindingBroadcast,
        },
      },
    });
    if (record.pendingTerminalNotification) {
      await this.emitHeadlessAutomationLifecycle(params.backend, record.pendingTerminalNotification);
    }
    return {
      backend: params.backend,
      headlessThreadId: turn.threadId,
      queueEntryId,
      threadId: params.agentThreadId,
      turnId: turn.turnId,
    };
  }

  async emitHeadlessAutomationLifecycle(
    backend: AppServerBackendKind,
    notification: AppServerNotification,
  ): Promise<void> {
    if (
      notification.method !== "turn/completed" &&
      notification.method !== "turn/failed" &&
      notification.method !== "turn/cancelled"
    ) {
      return;
    }

    const turnId = turnIdFromTerminalNotification(notification);
    if (!turnId) {
      return;
    }
    const pendingKey = buildHeadlessAutomationTurnKey(backend, notification.params.threadId, "");
    const run = this.headlessAutomationTurns.get(
      buildHeadlessAutomationTurnKey(
        backend,
        notification.params.threadId,
        turnId,
      ),
    );
    if (!run) {
      const pending = this.headlessAutomationTurns.get(pendingKey);
      if (pending) {
        // The Agent must observe its run starting before it finishes. Keep
        // authorization live during startup and publish this after "started".
        pending.pendingTerminalNotification = notification;
        return;
      }
    }
    if (!run) {
      backendRegistryLog.debug("terminal turn did not match a headless automation", {
        backend,
        method: notification.method,
        threadId: notification.params.threadId,
        turnId,
      });
      return;
    }
    this.headlessAutomationTurns.delete(
      buildHeadlessAutomationTurnKey(
        backend,
        notification.params.threadId,
        turnId,
      ),
    );
    this.headlessAutomationTurns.delete(pendingKey);
    for (const registration of run.mcpRegistrations ?? []) registration.revoke();
    backendRegistryLog.info("automation headless turn reached terminal status", {
      agentThreadId: run.agentThreadId,
      automationName: run.automationName,
      automationRunId: run.automationRunId,
      backend,
      finalTextLength: finalTextFromTerminalNotification(notification)?.length ?? 0,
      method: notification.method,
      queueEntryId: run.queueEntryId,
      threadId: notification.params.threadId,
      turnId,
    });

    await this.context.emit({
      backend,
      notification: {
        method: "thread/turnQueue/updated",
        params: {
          threadId: run.agentThreadId,
          queueEntryId: run.queueEntryId,
          origin: "automation",
          automationRunId: run.automationRunId,
          automationName: run.automationName,
          status: "terminal",
          turnId,
          errorMessage: errorMessageFromTerminalNotification(notification),
          finalText: finalTextFromTerminalNotification(notification),
          terminalStatus: notification.method,
          suppressBindingBroadcast: run.suppressBindingBroadcast,
        },
      },
    });
  }

  headlessAutomationErrorNoticeContext(
    backend: AppServerBackendKind,
    executionThreadId: string,
  ): AgentEvent["errorNoticeContext"] | undefined {
    for (const run of this.headlessAutomationTurns.values()) {
      if (run.backend !== backend || run.executionThreadId !== executionThreadId) {
        continue;
      }
      const title = this.host().getCachedThreadSummary({
        backend,
        threadId: run.agentThreadId,
      })?.title ?? run.automationName;
      return {
        backend,
        threadId: run.agentThreadId,
        ...(title ? { title } : {}),
        ...(run.automationName ? { automationName: run.automationName } : {}),
      };
    }
    return undefined;
  }

  findHeadlessAutomationTurnForRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
  ):
    | {
        agentThreadId: string;
        automationName?: string;
        automationRunId: string;
        executionMode: ThreadExecutionMode;
        queueEntryId: string;
        mcpConnectionIds?: string[];
        mcpGrantedConnectionIds?: string[];
        mcpServerAliases?: Record<string, string[]>;
        mcpAllowedServerNames?: string[];
        toolAllowlist?: string[];
      }
    | undefined {
    const turnId = request.params.turnId?.trim();
    if (turnId) {
      return this.headlessAutomationTurns.get(
        buildHeadlessAutomationTurnKey(backend, request.params.threadId, turnId),
      ) ?? this.headlessAutomationTurns.get(buildHeadlessAutomationTurnKey(backend, request.params.threadId, ""));
    }

    const keyPrefix = `${backend}:${request.params.threadId}:`;
    let match:
      | {
          agentThreadId: string;
          automationName?: string;
          automationRunId: string;
          executionMode: ThreadExecutionMode;
          queueEntryId: string;
        }
      | undefined;
    for (const [key, run] of this.headlessAutomationTurns.entries()) {
      if (!key.startsWith(keyPrefix)) {
        continue;
      }
      if (match) {
        return undefined;
      }
      match = run;
    }
    return match;
  }

  findHeadlessAutomationForThread(backend: AppServerBackendKind, threadId: string) {
    const matches = [...this.headlessAutomationTurns.values()].filter((run) => run.backend === backend && run.executionThreadId === threadId);
    return matches.length === 1 ? matches[0] : undefined;
  }
}
