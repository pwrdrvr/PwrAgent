import type {
  AgentToolCatalogId,
  AgentToolCatalogSummary,
  ThreadAgentMetadata,
} from "@pwragent/shared";
import { AUTOMATION_INSPECTION_TOOL_NAMESPACE } from "@pwragent/shared";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import {
  buildAutomationInspectionToolRouter,
  type AutomationInspectionHandler,
} from "../automations/automation-inspection-agent-tools.js";

export type ResolvedAgentToolCatalog = {
  id: AgentToolCatalogId;
  summary: AgentToolCatalogSummary;
  dynamicTools: DynamicToolSpec[];
};

export function resolveAgentToolCatalogs(params: {
  agent?: ThreadAgentMetadata | { name: string; instructions?: string } | null;
  automationInspectionHandler?: AutomationInspectionHandler;
}): ResolvedAgentToolCatalog[] {
  if (!params.agent) {
    return [];
  }

  const automationRouter = buildAutomationInspectionToolRouter(
    params.automationInspectionHandler,
  );
  const dynamicTools = automationRouter.buildDynamicToolSpecs();
  return [
    {
      id: "automation_inspection",
      dynamicTools,
      summary: {
        id: "automation_inspection",
        namespace: AUTOMATION_INSPECTION_TOOL_NAMESPACE,
        enabled: true,
        toolCount: dynamicTools.length,
        fingerprint: buildCatalogFingerprint({
          id: "automation_inspection",
          namespace: AUTOMATION_INSPECTION_TOOL_NAMESPACE,
          tools: dynamicTools,
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
