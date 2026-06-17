import {
  buildPendingRequestActions,
  buildPendingRequestApprovalContext,
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
  directoryPaths?: string[];
  id: string;
  request: AppServerPendingRequestNotification;
}): MessagingApprovalIntent {
  const prompt = stringField(params.request.params.prompt) ?? "Approve this action?";
  const command = extractCommand(params.request.params);
  const context = buildPendingRequestApprovalContext(params.request, {
    directoryPaths: params.directoryPaths,
  });
  const fileContext = approvalContextMarkdown(context);
  const decisions = applyActionCapabilityLimits(
    buildDecisions(params.request),
    params.capabilityProfile,
  );
  const replyInstruction = approvalReplyInstruction(decisions);

  return {
    id: params.id,
    kind: "approval",
    createdAt: params.createdAt,
    title: titleForRequest(params.request),
    ...(context ? { context } : {}),
    body: [
      prompt,
      command
        ? ["Command:", "```shell", stripDisplayShellWrapper(command), "```"].join("\n")
        : undefined,
      fileContext ? ["Context:", fileContext].join("\n") : undefined,
      replyInstruction.body,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n"),
    fallbackText: replyInstruction.fallbackText,
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

function approvalReplyInstruction(
  decisions: MessagingApprovalIntent["decisions"],
): { body: string; fallbackText: string } {
  const examples = new Set<string>();
  for (const decision of decisions) {
    if (decision.fallbackText) {
      examples.add(decision.fallbackText);
    }
  }
  if (decisions.some((decision) => decision.decision === "accept")) {
    examples.add("yes");
  }
  if (decisions.some((decision) => decision.decision === "accept_for_session")) {
    examples.add("yes for this session");
  }
  if (
    decisions.some(
      (decision) => decision.decision === "accept_with_execpolicy_amendment",
    )
  ) {
    examples.add("approve and remember");
  }
  if (decisions.some((decision) => decision.decision === "decline")) {
    examples.add("no");
  }
  if (decisions.some((decision) => decision.decision === "cancel")) {
    examples.add("cancel");
  }

  if (!examples.size) {
    return {
      body: "Use a supported provider action to respond.",
      fallbackText: "Use a supported provider action to respond.",
    };
  }

  const quotedExamples = Array.from(examples, (example) => `"${example}"`);
  const list =
    quotedExamples.length === 1
      ? quotedExamples[0]!
      : `${quotedExamples.slice(0, -1).join(", ")}, or ${quotedExamples.at(-1)}`;
  return {
    body: `Reply with ${list}, or use a button.`,
    fallbackText: `Reply with ${Array.from(examples).join(", ")}, or use a button.`,
  };
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

function approvalContextMarkdown(
  context: ReturnType<typeof buildPendingRequestApprovalContext>,
): string | undefined {
  if (!context) {
    return undefined;
  }

  const lines: string[] = [];
  if (context.action) {
    lines.push(`Action: ${context.action}`);
  }
  if (context.displayPath) {
    lines.push(`File: ${context.displayPath}`);
  }
  if (context.displayGrantRoot) {
    lines.push(`Write root: ${context.displayGrantRoot}`);
  }
  if (context.diff) {
    lines.push(["Diff:", "```diff", context.diff, "```"].join("\n"));
  }

  return lines.join("\n") || undefined;
}

function stripDisplayShellWrapper(command: string): string {
  const match = /^\/bin\/(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return match?.[2] ?? command;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
