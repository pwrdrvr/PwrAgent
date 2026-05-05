import type {
  AppServerPendingRequestNotification,
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
    buildDecisions(params.request.params.options),
    params.capabilityProfile,
  );

  return {
    id: params.id,
    kind: "approval",
    createdAt: params.createdAt,
    title: titleForRequest(params.request),
    body: [
      prompt,
      command ? ["Command:", "```shell", stripDisplayShellWrapper(command), "```"].join("\n") : undefined,
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
  options: string[] | undefined,
): MessagingApprovalIntent["decisions"] {
  const provided = options
    ?.map((option, index) => decisionFromOption(option, index))
    .filter((decision): decision is MessagingApprovalIntent["decisions"][number] =>
      Boolean(decision),
    );
  if (provided && provided.length > 0) {
    return provided;
  }

  return [
    {
      id: "approval:accept",
      label: "Approve Once",
      decision: "accept",
      style: "primary",
      fallbackText: "1",
    },
    {
      id: "approval:accept_for_session",
      label: "Approve for Session",
      decision: "accept_for_session",
      style: "secondary",
      fallbackText: "2",
    },
    {
      id: "approval:decline",
      label: "Decline",
      decision: "decline",
      style: "danger",
      fallbackText: "3",
    },
    {
      id: "approval:cancel",
      label: "Cancel",
      decision: "cancel",
      style: "secondary",
      fallbackText: "4",
    },
  ];
}

function decisionFromOption(
  option: string,
  index: number,
): MessagingApprovalIntent["decisions"][number] | undefined {
  const normalized = option.toLowerCase();
  const decision: MessagingApprovalDecision | undefined = normalized.includes("session")
    ? "accept_for_session"
    : normalized.includes("decline") || normalized.includes("deny") || normalized === "no"
      ? "decline"
      : normalized.includes("cancel")
        ? "cancel"
        : normalized.includes("approve") ||
            normalized.includes("allow") ||
            normalized.includes("accept") ||
            normalized === "yes"
          ? "accept"
          : undefined;
  if (!decision) {
    return undefined;
  }

  return {
    id: `approval:${decision}`,
    label: option,
    decision,
    style: decision === "accept" ? "primary" : decision === "decline" ? "danger" : "secondary",
    fallbackText: String(index + 1),
  };
}

function extractCommand(params: AppServerPendingRequestNotification["params"]): string | undefined {
  const direct =
    stringField(params.command) ??
    stringField(params.shellCommand) ??
    stringField(params.commandText);
  if (direct) {
    return direct;
  }

  const command = params.command;
  if (command && typeof command === "object" && !Array.isArray(command)) {
    const record = command as Record<string, unknown>;
    return stringField(record.command) ?? stringField(record.cmd) ?? stringField(record.text);
  }

  return undefined;
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
