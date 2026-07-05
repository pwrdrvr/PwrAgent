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
}) => Promise<{
  message?: string;
  ok: boolean;
  unsupported?: boolean;
  errorMessage?: string;
}>;

export type AutomationTargetMessageDeliveryHandler = (params: {
  intentId: string;
  target: Extract<
    AutomationOutputActionDefinition,
    { kind: "messaging_target" }
  >["target"];
  text: string;
}) => Promise<{
  message?: string;
  ok: boolean;
  unsupported?: boolean;
  errorMessage?: string;
}>;

const sourceMessageDeliveryHandlers =
  new Set<AutomationSourceMessageDeliveryHandler>();
const targetMessageDeliveryHandlers =
  new Set<AutomationTargetMessageDeliveryHandler>();

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

export function registerAutomationTargetMessageDeliveryHandler(
  handler: AutomationTargetMessageDeliveryHandler,
): () => void {
  targetMessageDeliveryHandlers.add(handler);
  return () => {
    targetMessageDeliveryHandlers.delete(handler);
  };
}

export function setAutomationTargetMessageDeliveryHandler(
  handler: AutomationTargetMessageDeliveryHandler | undefined,
): void {
  targetMessageDeliveryHandlers.clear();
  if (handler) {
    targetMessageDeliveryHandlers.add(handler);
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
      results.push(
        resultFor(action, "skipped", { message: "Action is disabled." }),
      );
      continue;
    }
    const previous = existing.get(action.id);
    // "completed" → already delivered. "pending" → a prior attempt persisted an
    // in-flight marker and the process restarted before recording the outcome;
    // do not blindly re-post (favor no-duplicate over guaranteed delivery). The
    // analysis is still preserved via the artifact/agent_context.
    if (previous?.status === "completed" || previous?.status === "pending") {
      results.push(previous);
      continue;
    }
    if (action.kind === "agent_context") {
      results.push(
        resultFor(action, "completed", {
          message: "Automation artifact is available to the Agent thread.",
        }),
      );
      continue;
    }
    if (action.kind === "messaging_target") {
      if (targetMessageDeliveryHandlers.size === 0) {
        results.push(
          resultFor(action, "unsupported", {
            errorMessage:
              "Alternate messaging target delivery is not available.",
          }),
        );
        continue;
      }
      const text = renderActionMessage(params.artifact);
      if (!text) {
        results.push(
          resultFor(action, "skipped", {
            message: "No user-visible automation output to deliver.",
          }),
        );
        continue;
      }
      const attemptedAt = Date.now();
      const delivery = await deliverTargetMessage({
        intentId: `automation-action:${params.artifact.runId}:${action.id}`,
        target: action.target,
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
      continue;
    }
    if (!params.source) {
      results.push(
        resultFor(action, "failed", {
          errorMessage:
            "Source-message action requires inbound source metadata.",
        }),
      );
      continue;
    }
    if (sourceMessageDeliveryHandlers.size === 0) {
      results.push(
        resultFor(action, "unsupported", {
          errorMessage: "Source-message delivery is not available.",
        }),
      );
      continue;
    }
    const text = renderActionMessage(params.artifact);
    if (!text) {
      results.push(
        resultFor(action, "skipped", {
          message: "No user-visible automation output to deliver.",
        }),
      );
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

/**
 * Build "pending" (in-flight) markers for delivery actions that haven't already
 * reached a terminal/pending state. Persisted BEFORE the provider post so a
 * crash mid-delivery leaves a marker that fences re-posting on restart.
 * Only network-delivery actions need this; agent_context completes locally.
 */
export function buildPendingDeliveryActionResults(
  actions: AutomationOutputActionDefinition[],
  existing: AutomationOutputActionResult[],
): AutomationOutputActionResult[] {
  const byId = new Map(existing.map((result) => [result.actionId, result]));
  const now = Date.now();
  const pending: AutomationOutputActionResult[] = [];
  for (const action of actions) {
    if (action.enabled === false) continue;
    if (
      action.kind !== "source_message"
      && action.kind !== "messaging_target"
    ) {
      continue;
    }
    const previous = byId.get(action.id);
    if (previous?.status === "completed" || previous?.status === "pending") {
      continue;
    }
    pending.push({
      actionId: action.id,
      kind: action.kind,
      status: "pending",
      attemptedAt: now,
    });
  }
  return pending;
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
  return (
    unsupported ?? {
      ok: false,
      unsupported: true,
      errorMessage: "Source-message delivery is not available.",
    }
  );
}

async function deliverTargetMessage(
  params: Parameters<AutomationTargetMessageDeliveryHandler>[0],
): ReturnType<AutomationTargetMessageDeliveryHandler> {
  let unsupported:
    | Awaited<ReturnType<AutomationTargetMessageDeliveryHandler>>
    | undefined;
  for (const handler of targetMessageDeliveryHandlers) {
    const result = await handler(params);
    if (result.ok || !result.unsupported) {
      return result;
    }
    unsupported = result;
  }
  return (
    unsupported ?? {
      ok: false,
      unsupported: true,
      errorMessage: "Alternate messaging target delivery is not available.",
    }
  );
}

function renderActionMessage(
  artifact: AutomationRunArtifact,
): string | undefined {
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
    completedAt:
      status === "completed" || status === "skipped" ? now : undefined,
    ...extra,
  };
}
