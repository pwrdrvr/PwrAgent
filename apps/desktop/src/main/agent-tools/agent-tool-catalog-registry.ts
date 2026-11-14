import type { ForgeReadHandler } from "./pwragent-forge-agent-tools";
import { buildForgeToolDefinitions, type ForgePrToolHandler } from "./pwragent-forge-pr-agent-tools";
import type { TokenMiserFocusedSummaries } from "../token-miser/token-miser-focused";
import type {
  AgentToolCatalogId,
  AgentToolCatalogSummary,
  ForgeAgentToolPolicy,
} from "@pwragent/shared";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import {
  buildAutomationInspectionToolRouter,
  type AutomationInspectionHandler,
} from "../automations/automation-inspection-agent-tools.js";
import {
  buildPwrAgentAppToolDefinitions,
  type PwrAgentAppManagementHandler,
} from "./pwragent-app-agent-tools.js";
import {
  buildPwrAgentThreadToolRouter,
  type PwrAgentThreadInspectionHandler,
} from "./pwragent-thread-agent-tools.js";
import {
  buildPwrAgentMessagingToolRouter,
  type PwrAgentMessagingHandler,
} from "./pwragent-messaging-agent-tools.js";
import {
  buildPwrAgentThreadOrchestrationToolDefinitions,
  type PwrAgentThreadOrchestrationHandler,
} from "./pwragent-thread-orchestration-agent-tools.js";
import {
  buildPwrAgentTaskMonitorToolDefinitions,
  type PwrAgentTaskMonitorHandler,
} from "./pwragent-task-monitor-agent-tools.js";
import {
  buildPwrAgentFederationToolRouter,
  type PwrAgentFederationHandler,
} from "./pwragent-federation-agent-tools.js";
import {
  buildPwrAgentMcpConnectionToolDefinitions,
  type PwrAgentMcpConnectionHandler,
} from "./pwragent-mcp-connection-agent-tools.js";
import {
  buildPwrAgentStarMapToolRouter,
  type PwrAgentStarMapHandler,
} from "./pwragent-star-map-agent-tools.js";
import {
  buildPwrAgentThreadTodoToolRouter,
  type PwrAgentThreadTodoHandler,
} from "./pwragent-thread-todo-agent-tools.js";
import {
  buildPwrAgentOpenAIDecisionsToolRouter,
  type PwrAgentOpenAIDecisionsHandler,
} from "./pwragent-openai-decisions-agent-tools.js";
import { buildPwrAgentToolGuideDefinition } from "./pwragent-tool-guide.js";
import { AgentToolRouter } from "./agent-tool-router.js";
import { buildTokenMiserToolDefinitions } from "./token-miser-agent-tools.js";
import type { TokenMiserStore } from "../token-miser/token-miser-store.js";
import { buildMcpGatewayToolDefinitions } from "./pwragent-mcp-gateway-tools.js";
import type { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service.js";

export type ResolvedAgentToolCatalog = {
  id: AgentToolCatalogId;
  summary: AgentToolCatalogSummary;
  dynamicTools: DynamicToolSpec[];
  router: AgentToolRouter;
};

export function resolveAgentToolCatalogs(params: {
  appManagementHandler?: PwrAgentAppManagementHandler;
  automationInspectionHandler?: AutomationInspectionHandler;
  federationHandler?: PwrAgentFederationHandler;
  mcpConnectionHandler?: PwrAgentMcpConnectionHandler;
  mcpGatewayTools?: McpGatewayToolService;
  messagingHandler?: PwrAgentMessagingHandler;
  taskMonitorHandler?: PwrAgentTaskMonitorHandler;
  threadInspectionHandler?: PwrAgentThreadInspectionHandler;
  forgeReadHandler?: ForgeReadHandler;
  forgePrToolHandler?: ForgePrToolHandler;
  /** Omitted tools are not advertised. Without a policy every forge tool is. */
  forgeToolPolicy?: ForgeAgentToolPolicy;
  threadOrchestrationHandler?: PwrAgentThreadOrchestrationHandler;
  tokenMiserStore?: TokenMiserStore;
  tokenMiserFocused?: TokenMiserFocusedSummaries;
  starMapHandler?: PwrAgentStarMapHandler;
  threadTodoHandler?: PwrAgentThreadTodoHandler;
  openAIDecisionsHandler?: PwrAgentOpenAIDecisionsHandler;
}, options?: {
  taskMonitorRole?: "parent" | "monitor" | "all";
}): ResolvedAgentToolCatalog[] {
  const automationRouter = buildAutomationInspectionToolRouter(
    params.automationInspectionHandler,
  );
  const automationDynamicTools = automationRouter.buildDynamicToolSpecs();
  const appRouter = new AgentToolRouter([
    ...buildPwrAgentAppToolDefinitions(params.appManagementHandler),
    buildPwrAgentToolGuideDefinition(),
  ]);
  const appDynamicTools = appRouter.buildDynamicToolSpecs();
  const threadRouter = buildPwrAgentThreadToolRouter(params.threadInspectionHandler);
  const threadDynamicTools = threadRouter.buildDynamicToolSpecs();
  const forgeRouter = new AgentToolRouter(buildForgeToolDefinitions({
    forgeReadHandler: params.forgeReadHandler,
    forgePrToolHandler: params.forgePrToolHandler,
    policy: params.forgeToolPolicy,
  }));
  const forgeDynamicTools = forgeRouter.buildDynamicToolSpecs();
  const messagingRouter = buildPwrAgentMessagingToolRouter(params.messagingHandler);
  const messagingDynamicTools = messagingRouter.buildDynamicToolSpecs();
  const threadOrchestrationRouter = new AgentToolRouter(
    [
      ...buildPwrAgentThreadOrchestrationToolDefinitions(
        params.threadOrchestrationHandler,
      ),
      ...buildPwrAgentTaskMonitorToolDefinitions(
        params.taskMonitorHandler,
        options?.taskMonitorRole,
      ),
    ],
  );
  const threadOrchestrationDynamicTools =
    threadOrchestrationRouter.buildDynamicToolSpecs();
  const federationRouter = buildPwrAgentFederationToolRouter(
    params.federationHandler,
  );
  const federationDynamicTools = federationRouter.buildDynamicToolSpecs();
  const mcpConnectionRouter = new AgentToolRouter([
    ...buildPwrAgentMcpConnectionToolDefinitions(params.mcpConnectionHandler),
    ...buildMcpGatewayToolDefinitions(params.mcpGatewayTools, params.tokenMiserStore),
  ]);
  const mcpConnectionDynamicTools = mcpConnectionRouter.buildDynamicToolSpecs();
  const tokenMiserRouter = new AgentToolRouter(
    buildTokenMiserToolDefinitions(params.tokenMiserStore, params.tokenMiserFocused),
  );
  const tokenMiserDynamicTools = tokenMiserRouter.buildDynamicToolSpecs();
  const starMapRouter = buildPwrAgentStarMapToolRouter(params.starMapHandler);
  const starMapDynamicTools = starMapRouter.buildDynamicToolSpecs();
  const threadTodoRouter = buildPwrAgentThreadTodoToolRouter(
    params.threadTodoHandler,
  );
  const threadTodoDynamicTools = threadTodoRouter.buildDynamicToolSpecs();
  // Five fixed tools for every registered decision. A registered decision is
  // an argument to decisions_invoke, never a tool of its own: Codex fixes its
  // dynamic tools at thread start, and a per-decision tool would copy its
  // prompt into every transcript that saw the catalog.
  const openAIDecisionsRouter = buildPwrAgentOpenAIDecisionsToolRouter(
    params.openAIDecisionsHandler,
  );
  const openAIDecisionsDynamicTools = openAIDecisionsRouter.buildDynamicToolSpecs();
  return [
    {
      id: "automation_inspection",
      dynamicTools: automationDynamicTools,
      router: automationRouter,
      summary: {
        id: "automation_inspection",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: countDynamicTools(automationDynamicTools),
        fingerprint: buildCatalogFingerprint({
          id: "automation_inspection",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: automationDynamicTools,
        }),
      },
    },
    {
      id: "app_management",
      dynamicTools: appDynamicTools,
      router: appRouter,
      summary: {
        id: "app_management",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: countDynamicTools(appDynamicTools),
        fingerprint: buildCatalogFingerprint({
          id: "app_management",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: appDynamicTools,
        }),
      },
    },
    {
      id: "thread_inspection",
      dynamicTools: threadDynamicTools,
      router: threadRouter,
      summary: {
        id: "thread_inspection",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: countDynamicTools(threadDynamicTools),
        fingerprint: buildCatalogFingerprint({
          id: "thread_inspection",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: threadDynamicTools,
        }),
      },
    },
    {
      id: "forge",
      dynamicTools: forgeDynamicTools,
      router: forgeRouter,
      summary: {
        id: "forge",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: forgeDynamicTools.length > 0,
        toolCount: countDynamicTools(forgeDynamicTools),
        ...(params.forgeToolPolicy && !params.forgeToolPolicy.enabled
          ? { unavailableReason: "Forge tools are off in Settings → Git." }
          : {}),
        fingerprint: buildCatalogFingerprint({
          id: "forge",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: forgeDynamicTools,
        }),
      },
    },
    {
      id: "messaging_context",
      dynamicTools: messagingDynamicTools,
      router: messagingRouter,
      summary: {
        id: "messaging_context",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: countDynamicTools(messagingDynamicTools),
        fingerprint: buildCatalogFingerprint({
          id: "messaging_context",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: messagingDynamicTools,
        }),
      },
    },
    {
      id: "thread_orchestration",
      dynamicTools: threadOrchestrationDynamicTools,
      router: threadOrchestrationRouter,
      summary: {
        id: "thread_orchestration",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: countDynamicTools(threadOrchestrationDynamicTools),
        fingerprint: buildCatalogFingerprint({
          id: "thread_orchestration",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: threadOrchestrationDynamicTools,
        }),
      },
    },
    {
      id: "star_map",
      dynamicTools: starMapDynamicTools,
      router: starMapRouter,
      summary: {
        id: "star_map",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: countDynamicTools(starMapDynamicTools),
        fingerprint: buildCatalogFingerprint({
          id: "star_map",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: starMapDynamicTools,
        }),
      },
    },
    {
      id: "thread_todos",
      dynamicTools: threadTodoDynamicTools,
      router: threadTodoRouter,
      summary: {
        id: "thread_todos",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: countDynamicTools(threadTodoDynamicTools),
        fingerprint: buildCatalogFingerprint({
          id: "thread_todos",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: threadTodoDynamicTools,
        }),
      },
    },
    {
      id: "openai_decisions",
      dynamicTools: openAIDecisionsDynamicTools,
      router: openAIDecisionsRouter,
      summary: {
        id: "openai_decisions",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: Boolean(params.openAIDecisionsHandler),
        toolCount: countDynamicTools(openAIDecisionsDynamicTools),
        ...(!params.openAIDecisionsHandler
          ? { unavailableReason: "OpenAI Decisions are unavailable in this PwrAgent runtime." }
          : {}),
        fingerprint: buildCatalogFingerprint({
          id: "openai_decisions",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: openAIDecisionsDynamicTools,
        }),
      },
    },
    {
      id: "federation",
      dynamicTools: federationDynamicTools,
      router: federationRouter,
      summary: {
        id: "federation",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: countDynamicTools(federationDynamicTools),
        fingerprint: buildCatalogFingerprint({
          id: "federation",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: federationDynamicTools,
        }),
      },
    },
    {
      id: "mcp_connections",
      dynamicTools: mcpConnectionDynamicTools,
      router: mcpConnectionRouter,
      summary: {
        id: "mcp_connections",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: Boolean(params.mcpConnectionHandler),
        toolCount: countDynamicTools(mcpConnectionDynamicTools),
        ...(!params.mcpConnectionHandler
          ? { unavailableReason: "MCP connections are unavailable in this PwrAgent runtime." }
          : {}),
        fingerprint: buildCatalogFingerprint({
          id: "mcp_connections",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: mcpConnectionDynamicTools,
        }),
      },
    },
    {
      id: "token_miser",
      dynamicTools: tokenMiserDynamicTools,
      router: tokenMiserRouter,
      summary: {
        id: "token_miser",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: Boolean(params.tokenMiserStore),
        toolCount: countDynamicTools(tokenMiserDynamicTools),
        ...(!params.tokenMiserStore
          ? { unavailableReason: "Token Miser is disabled." }
          : {}),
        fingerprint: buildCatalogFingerprint({
          id: "token_miser",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: tokenMiserDynamicTools,
        }),
      },
    },
  ];
}

function buildCatalogFingerprint(params: {
  id: AgentToolCatalogId;
  namespace: string;
  tools: DynamicToolSpec[];
}): string {
  return [
    params.id,
    params.namespace,
    ...params.tools
      .flatMap((tool) =>
        tool.type === "namespace"
          ? tool.tools.map((nestedTool) => `${tool.name}/${nestedTool.name}`)
          : [tool.name],
      )
      .sort(),
  ].join(":");
}

function countDynamicTools(tools: DynamicToolSpec[]): number {
  return tools.reduce(
    (count, tool) =>
      count + (tool.type === "namespace" ? tool.tools.length : 1),
    0,
  );
}
