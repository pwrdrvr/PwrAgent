import {
  buildPendingRequestActions,
  type AppServerPendingRequestNotification,
  type PendingRequestAction,
} from "@pwragent/shared";
import type {
  MessagingApprovalDecision,
  MessagingApprovalIntent,
} from "@pwragent/messaging-interface";
import {
  applyActionCapabilityLimits,
  type MessagingCapabilityProfile,
} from "@pwragent/messaging-interface";

export function buildApprovalIntent(params: {
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
  request: AppServerPendingRequestNotification;
}): MessagingApprovalIntent {
  const prompt = stringField(params.request.params.prompt) ?? "Approve this action?";
  const command = extractCommand(params.request.params);
  const fileContext = extractFileContext(params.request.params);
  const decisions = applyActionCapabilityLimits(
    buildDecisions(params.request),
    params.capabilityProfile,
  );

  return {
    id: params.id,
    kind: "approval",
    createdAt: params.createdAt,
    title: titleForRequest(params.request),
    body: [
      prompt,
      command
        ? ["Command:", "```shell", stripDisplayShellWrapper(command), "```"].join("\n")
        : undefined,
      fileContext ? ["Context:", fileContext].join("\n") : undefined,
      "Reply with \"1\", \"2\", \"yes\", \"yes for this session\", \"no\", or use a button.",
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n"),
    fallbackText: "Reply yes, yes for this session, no, cancel, or a choice number.",
    decisions,
  };
}

function titleForRequest(request: AppServerPendingRequestNotification): string {
  if (request.method.toLowerCase().includes("command")) {
    return "Command Approval";
  }
  if (request.method.toLowerCase().includes("file")) {
    return "File Change Approval";
  }
  return "Approval Needed";
}

function buildDecisions(
  request: AppServerPendingRequestNotification,
): MessagingApprovalIntent["decisions"] {
  return buildPendingRequestActions(request).map((action) => ({
    id: action.id,
    label: action.label,
    decision: messagingDecisionFromPendingAction(action),
    style: action.style,
    fallbackText: action.fallbackText,
    response: action.response,
  }));
}

function messagingDecisionFromPendingAction(
  action: PendingRequestAction,
): MessagingApprovalDecision {
  return action.decision;
}

function extractCommand(
  params: AppServerPendingRequestNotification["params"],
): string | undefined {
  const promptCommand =
    commandFromApprovalText(stringField(params.prompt)) ??
    commandFromApprovalText(stringField(params.reason));
  const direct =
    stringField(params.command) ??
    stringField(params.shellCommand) ??
    stringField(params.commandText);
  if (direct && !isGenericShellToolTitle(direct)) {
    return direct;
  }
  if (promptCommand) {
    return promptCommand;
  }
  if (direct) {
    return direct;
  }

  const command = params.command;
  if (command && typeof command === "object" && !Array.isArray(command)) {
    const record = command as Record<string, unknown>;
    return (
      stringField(record.command) ??
      stringField(record.cmd) ??
      stringField(record.text)
    );
  }

  return undefined;
}

function commandFromApprovalText(text: string | undefined): string | undefined {
  const match = /^Requesting approval to Running:\s*(.+)$/imu.exec(text ?? "");
  return match?.[1]?.trim() || undefined;
}

function isGenericShellToolTitle(command: string): boolean {
  return /^(?:bash|shell|sh|zsh|terminal|tool)$/i.test(command.trim());
}

function extractFileContext(
  params: AppServerPendingRequestNotification["params"],
): string | undefined {
  const path =
    stringField(params.path) ??
    stringField(params.filePath) ??
    stringField(params.filename);
  const action = stringField(params.action) ?? stringField(params.operation);
  return [action, path].filter(Boolean).join(" ").trim() || undefined;
}

function stripDisplayShellWrapper(command: string): string {
  const match = /^\/bin\/(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return match?.[2] ?? command;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
