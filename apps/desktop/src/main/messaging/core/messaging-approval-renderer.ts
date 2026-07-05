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
  const prompt =
    stringField(params.request.params.prompt) ?? "Approve this action?";
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
        ? [
            "Command:",
            "```shell",
            stripDisplayShellWrapper(command),
            "```",
          ].join("\n")
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
  if (
    decisions.some((decision) => decision.decision === "accept_for_session")
  ) {
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
    commandFromApprovalText(stringField(params.prompt))
    ?? commandFromApprovalText(stringField(params.reason));
  const direct =
    stringField(params.command)
    ?? stringField(params.shellCommand)
    ?? stringField(params.commandText);
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
      stringField(record.command)
      ?? stringField(record.cmd)
      ?? stringField(record.text)
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
  const fileContexts = context.files?.length
    ? context.files
    : context.displayPath && context.path
      ? [
          {
            action: context.action,
            additions: undefined,
            diff: context.diff,
            displayPath: context.displayPath,
            path: context.path,
            removals: undefined,
          },
        ]
      : [];

  if (fileContexts.length === 1) {
    const file = fileContexts[0]!;
    if (file.action && file.action !== context.action) {
      lines.push(`Action: ${file.action}`);
    }
    lines.push(`File: ${file.displayPath}`);
  } else if (fileContexts.length > 1) {
    lines.push("Files:");
    for (const file of fileContexts) {
      lines.push(
        `- ${file.displayPath}${file.action ? ` (${file.action})` : ""}`,
      );
    }
  } else if (context.displayPath) {
    lines.push(`File: ${context.displayPath}`);
  }
  if (context.displayGrantRoot) {
    lines.push(`Write root: ${context.displayGrantRoot}`);
  }
  const diffSummary = summarizeApprovalDiffs(fileContexts, context.diff);
  if (diffSummary) {
    lines.push(`Diff: ${diffSummary}`);
  }

  return lines.join("\n") || undefined;
}

function summarizeApprovalDiffs(
  files: Array<{
    additions?: number;
    diff?: string;
    diffRef?: unknown;
    diffRefs?: unknown[];
    omittedReason?: string;
    removals?: number;
  }>,
  fallbackDiff: string | undefined,
): string | undefined {
  if (files.length) {
    const filesWithDiff = files.filter((file) =>
      Boolean(
        file.diff
        || file.diffRef
        || file.diffRefs?.length
        || file.omittedReason,
      ),
    );
    if (!filesWithDiff.length) {
      return undefined;
    }
    const totals = filesWithDiff.reduce<{
      additions: number;
      removals: number;
    }>(
      (sum, file) => {
        const counted = countDiffLines(file.diff);
        return {
          additions: sum.additions + (file.additions ?? counted.additions),
          removals: sum.removals + (file.removals ?? counted.removals),
        };
      },
      { additions: 0, removals: 0 },
    );
    return `${filesWithDiff.length.toLocaleString()} file${
      filesWithDiff.length === 1 ? "" : "s"
    }, +${totals.additions.toLocaleString()} -${totals.removals.toLocaleString()}`;
  }
  if (!fallbackDiff) {
    return undefined;
  }
  const counted = countDiffLines(fallbackDiff);
  return `+${counted.additions.toLocaleString()} -${counted.removals.toLocaleString()}`;
}

function countDiffLines(diff: string | undefined): {
  additions: number;
  removals: number;
} {
  if (!diff) {
    return { additions: 0, removals: 0 };
  }
  let additions = 0;
  let removals = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      removals += 1;
    }
  }
  return { additions, removals };
}

function stripDisplayShellWrapper(command: string): string {
  const match = /^\/bin\/(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/.exec(
    command.trim(),
  );
  return match?.[2] ?? command;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
