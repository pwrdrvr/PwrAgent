import type {
  AgentToolCatalogId,
  AgentToolCatalogSummary,
} from "@pwragent/shared";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import {
  buildAutomationInspectionToolRouter,
  type AutomationInspectionHandler,
} from "../automations/automation-inspection-agent-tools.js";
import {
  buildPwrAgentAppToolRouter,
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
  buildPwrAgentThreadOrchestrationToolRouter,
  type PwrAgentThreadOrchestrationHandler,
} from "./pwragent-thread-orchestration-agent-tools.js";

export type ResolvedAgentToolCatalog = {
  id: AgentToolCatalogId;
  summary: AgentToolCatalogSummary;
  dynamicTools: DynamicToolSpec[];
};

export function resolveAgentToolCatalogs(params: {
  appManagementHandler?: PwrAgentAppManagementHandler;
  automationInspectionHandler?: AutomationInspectionHandler;
  messagingHandler?: PwrAgentMessagingHandler;
  threadInspectionHandler?: PwrAgentThreadInspectionHandler;
  threadOrchestrationHandler?: PwrAgentThreadOrchestrationHandler;
}): ResolvedAgentToolCatalog[] {
  const automationRouter = buildAutomationInspectionToolRouter(
    params.automationInspectionHandler,
  );
  const automationDynamicTools = automationRouter.buildDynamicToolSpecs();
  const appRouter = buildPwrAgentAppToolRouter(params.appManagementHandler);
  const appDynamicTools = appRouter.buildDynamicToolSpecs();
  const threadRouter = buildPwrAgentThreadToolRouter(
    params.threadInspectionHandler,
  );
  const threadDynamicTools = threadRouter.buildDynamicToolSpecs();
  const messagingRouter = buildPwrAgentMessagingToolRouter(
    params.messagingHandler,
  );
  const messagingDynamicTools = messagingRouter.buildDynamicToolSpecs();
  const threadOrchestrationRouter = buildPwrAgentThreadOrchestrationToolRouter(
    params.threadOrchestrationHandler,
  );
  const threadOrchestrationDynamicTools =
    threadOrchestrationRouter.buildDynamicToolSpecs();
  return [
    {
      id: "automation_inspection",
      dynamicTools: automationDynamicTools,
      summary: {
        id: "automation_inspection",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: automationDynamicTools.length,
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
      summary: {
        id: "app_management",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: appDynamicTools.length,
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
      summary: {
        id: "thread_inspection",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: threadDynamicTools.length,
        fingerprint: buildCatalogFingerprint({
          id: "thread_inspection",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: threadDynamicTools,
        }),
      },
    },
    {
      id: "messaging_context",
      dynamicTools: messagingDynamicTools,
      summary: {
        id: "messaging_context",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: messagingDynamicTools.length,
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
      summary: {
        id: "thread_orchestration",
        namespace: PWRAGENT_TOOL_NAMESPACE,
        enabled: true,
        toolCount: threadOrchestrationDynamicTools.length,
        fingerprint: buildCatalogFingerprint({
          id: "thread_orchestration",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tools: threadOrchestrationDynamicTools,
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
    ...params.tools.map((tool) => tool.name).sort(),
  ].join(":");
}
