import type {
  AutomationOutputActionDefinition,
  AutomationOutputActionResult,
  AutomationRunArtifact,
  AutomationRunSourceMetadata,
} from "@pwragent/shared";
import {
  renderAutomationDecisionForMessaging,
  renderAutomationOutputForMessaging,
} from "./automation-output-decision.js";

export type AutomationSourceMessageDeliveryHandler = (params: {
  broadcast?: boolean;
  destination: Extract<
    AutomationOutputActionDefinition,
    { kind: "source_message" }
  >["destination"];
  intentId: string;
  source: AutomationRunSourceMetadata;
  text: string;
}) => Promise<{ message?: string; ok: boolean; unsupported?: boolean; errorMessage?: string }>;

const sourceMessageDeliveryHandlers = new Set<AutomationSourceMessageDeliveryHandler>();

export function registerAutomationSourceMessageDeliveryHandler(
  handler: AutomationSourceMessageDeliveryHandler,
): () => void {
  sourceMessageDeliveryHandlers.add(handler);
  return () => {
    sourceMessageDeliveryHandlers.delete(handler);
  };
}

export function setAutomationSourceMessageDeliveryHandler(
  handler: AutomationSourceMessageDeliveryHandler | undefined,
): void {
  sourceMessageDeliveryHandlers.clear();
  if (handler) {
    sourceMessageDeliveryHandlers.add(handler);
  }
}

export async function executeAutomationOutputActions(params: {
  actions: AutomationOutputActionDefinition[];
  artifact: AutomationRunArtifact;
  source?: AutomationRunSourceMetadata;
}): Promise<AutomationOutputActionResult[]> {
  const existing = new Map(
    params.artifact.actionResults.map((result) => [result.actionId, result]),
  );
  const results: AutomationOutputActionResult[] = [];
  for (const action of params.actions) {
    if (action.enabled === false) {
      results.push(resultFor(action, "skipped", { message: "Action is disabled." }));
      continue;
    }
    const previous = existing.get(action.id);
    if (previous?.status === "completed") {
      results.push(previous);
      continue;
    }
    if (action.kind === "agent_context") {
      results.push(resultFor(action, "completed", {
        message: "Automation artifact is available to the Agent thread.",
      }));
      continue;
    }
    if (action.kind === "messaging_target") {
      results.push(resultFor(action, "unsupported", {
        errorMessage: "Alternate messaging targets are not supported yet.",
      }));
      continue;
    }
    if (!params.source) {
      results.push(resultFor(action, "failed", {
        errorMessage: "Source-message action requires inbound source metadata.",
      }));
      continue;
    }
    if (sourceMessageDeliveryHandlers.size === 0) {
      results.push(resultFor(action, "unsupported", {
        errorMessage: "Source-message delivery is not available.",
      }));
      continue;
    }
    const text = renderActionMessage(params.artifact);
    if (!text) {
      results.push(resultFor(action, "skipped", {
        message: "No user-visible automation output to deliver.",
      }));
      continue;
    }
    const attemptedAt = Date.now();
    const delivery = await deliverSourceMessage({
      broadcast: action.broadcast,
      destination: action.destination,
      intentId: `automation-action:${params.artifact.runId}:${action.id}`,
      source: params.source,
      text,
    });
    results.push({
      actionId: action.id,
      kind: action.kind,
      status: delivery.ok
        ? "completed"
        : delivery.unsupported
          ? "unsupported"
          : "failed",
      attemptedAt,
      completedAt: delivery.ok ? Date.now() : undefined,
      message: delivery.message,
      errorMessage: delivery.errorMessage,
    });
  }
  return results;
}

async function deliverSourceMessage(
  params: Parameters<AutomationSourceMessageDeliveryHandler>[0],
): ReturnType<AutomationSourceMessageDeliveryHandler> {
  let unsupported:
    | Awaited<ReturnType<AutomationSourceMessageDeliveryHandler>>
    | undefined;
  for (const handler of sourceMessageDeliveryHandlers) {
    const result = await handler(params);
    if (result.ok || !result.unsupported) {
      return result;
    }
    unsupported = result;
  }
  return unsupported ?? {
    ok: false,
    unsupported: true,
    errorMessage: "Source-message delivery is not available.",
  };
}

function renderActionMessage(artifact: AutomationRunArtifact): string | undefined {
  return artifact.outputDecision?.kind === "post_card"
    ? renderAutomationDecisionForMessaging(artifact.outputDecision)
    : renderAutomationOutputForMessaging(artifact.finalText);
}

function resultFor(
  action: AutomationOutputActionDefinition,
  status: AutomationOutputActionResult["status"],
  extra: Pick<AutomationOutputActionResult, "errorMessage" | "message"> = {},
): AutomationOutputActionResult {
  const now = Date.now();
  return {
    actionId: action.id,
    kind: action.kind,
    status,
    attemptedAt: now,
    completedAt: status === "completed" || status === "skipped" ? now : undefined,
    ...extra,
  };
}
