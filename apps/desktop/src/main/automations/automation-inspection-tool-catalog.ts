import type { AutomationInspectionOperationName } from "@pwragent/shared";
import { AUTOMATION_INSPECTION_OPERATION_NAMES } from "@pwragent/shared";

export type AutomationInspectionToolCatalogEntry = {
  name: AutomationInspectionOperationName;
  description: string;
  inputSchema: Record<string, unknown>;
};

const TOOL_CATALOG: Record<
  AutomationInspectionOperationName,
  Omit<AutomationInspectionToolCatalogEntry, "name">
> = {
  list_automations: {
    description:
      "List automations attached to this PwrAgent Agent thread with compact status and latest-run metadata.",
    inputSchema: {
      type: "object",
      properties: {
        includePaused: { type: "boolean" },
        limit: { type: "number", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  summarize_automation_status: {
    description:
      "Summarize automation health and recent run activity for this PwrAgent Agent thread.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1 },
        since: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  list_automation_runs: {
    description:
      "List recent automation runs for this Agent thread or one attached automation.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: { type: "string" },
        limit: { type: "number", minimum: 1 },
        since: { type: "number" },
        statuses: {
          type: "array",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    },
  },
  get_automation_run: {
    description:
      "Inspect one automation run's status, timing, trigger, output summary, and error metadata.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  get_automation_run_artifact: {
    description:
      "Fetch one automation run's stored output artifact, card decision, and bounded transcript events.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        eventLimit: { type: "number", minimum: 1 },
        textLimitChars: { type: "number", minimum: 1 },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
};

export function buildAutomationInspectionToolCatalog(): AutomationInspectionToolCatalogEntry[] {
  return AUTOMATION_INSPECTION_OPERATION_NAMES.map((name) => ({
    name,
    ...TOOL_CATALOG[name],
  }));
}
