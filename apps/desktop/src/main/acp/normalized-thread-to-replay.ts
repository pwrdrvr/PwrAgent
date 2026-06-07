/**
 * Adapts the kit's coalesced `NormalizedThread` (built by
 * `reduceNormalizedThread`) into PwrAgent's legacy `AppServerThreadReplay`
 * shape — the view-model the renderer + persistence still speak today.
 *
 * This is the bridge Phase B needs to swap the in-tree
 * `AcpSessionReplayNormalizer` for the kit's `AcpSessionNormalizer` without
 * touching the renderer: kit events → `reduceNormalizedThread` → this adapter →
 * the existing `AppServerThreadReplay`. The KTD-P3 parity test asserts the
 * adapted output matches what the in-tree normalizer produces from the same
 * transcript.
 */
import type {
  NormalizedActivityEntry,
  NormalizedMessageEntry,
  NormalizedPlanEntry,
  NormalizedThread,
  NormalizedThreadActivity,
  NormalizedToolCall,
  NormalizedToolStatus,
} from "@pwrdrvr/agent-core";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadActivityStatus,
  AppServerThreadEntry,
  AppServerThreadMessage,
  AppServerThreadPlanStep,
  AppServerThreadReplay,
  AppServerThreadStatus,
} from "@pwragent/shared";

export function normalizedThreadToReplay(thread: NormalizedThread): AppServerThreadReplay {
  const entries: AppServerThreadEntry[] = thread.entries.map((entry) => {
    if (entry.type === "message") {
      return messageEntryToReplay(entry);
    }
    if (entry.type === "activity") {
      return activityEntryToReplay(entry);
    }
    return planEntryToReplay(entry);
  });

  const messages: AppServerThreadMessage[] = thread.messages.map((m) => ({
    id: m.id,
    role: m.role === "system" ? "assistant" : m.role,
    text: m.text,
  }));

  return {
    entries,
    messages,
    ...(thread.lastUserMessage !== undefined
      ? { lastUserMessage: thread.lastUserMessage }
      : {}),
    ...(thread.lastAssistantMessage !== undefined
      ? { lastAssistantMessage: thread.lastAssistantMessage }
      : {}),
    pagination: { supportsPagination: false, hasPreviousPage: false },
    threadStatus: threadStatus(thread.status),
  };
}

function messageEntryToReplay(entry: NormalizedMessageEntry): AppServerThreadEntry {
  return {
    type: "message",
    id: entry.id,
    role: entry.role === "system" ? "assistant" : entry.role,
    text: entry.text,
  };
}

function activityEntryToReplay(entry: NormalizedActivityEntry): AppServerThreadEntry {
  return {
    type: "activity",
    id: entry.id,
    summary: entry.summary,
    ...(entry.status ? { status: activityStatus(entry.status) } : {}),
    details: entry.toolCalls.map(toolCallToDetail),
  };
}

function planEntryToReplay(entry: NormalizedPlanEntry): AppServerThreadEntry {
  const steps: AppServerThreadPlanStep[] = entry.steps.map((s) => ({
    step: s.step,
    status: s.status,
  }));
  return {
    type: "plan",
    id: entry.id,
    ...(entry.explanation !== undefined ? { explanation: entry.explanation } : {}),
    steps,
  };
}

function toolCallToDetail(tool: NormalizedToolCall): AppServerThreadActivityDetail {
  // NOTE: the in-tree normalizer keeps tool status on the ACTIVITY entry, not
  // the detail (detail has no `status`), so we deliberately don't set it here.
  //
  // Command-detail shim (reconciles KTD-P3 finding #2): the kit sets
  // `command.displayCommand = <title>` even for read/write tools, but the
  // in-tree only emits a command detail when there's REAL command evidence
  // (`command || output !== undefined || exitCode !== undefined`). Mirror that
  // — surface a command detail only when the kit gives us a raw command, output,
  // or exit code, so a conflated read title doesn't masquerade as a command.
  const hasRealCommand =
    tool.command !== undefined &&
    (tool.command.rawCommand !== undefined ||
      tool.command.output !== undefined ||
      tool.command.exitCode !== undefined);
  return {
    id: tool.id,
    kind: detailKind(tool.kind),
    label: tool.label,
    ...(hasRealCommand && tool.command
      ? {
          command: {
            displayCommand: tool.command.displayCommand,
            ...(tool.command.rawCommand !== undefined
              ? { rawCommand: tool.command.rawCommand }
              : {}),
            ...(tool.command.cwd !== undefined ? { cwd: tool.command.cwd } : {}),
            ...(tool.command.output !== undefined ? { output: tool.command.output } : {}),
            ...(tool.command.exitCode !== undefined
              ? { exitCode: tool.command.exitCode }
              : {}),
          },
        }
      : {}),
    ...(tool.fileDiff
      ? {
          fileDiff: {
            kind: tool.fileDiff.kind,
            diff: tool.fileDiff.diff,
            additions: tool.fileDiff.additions,
            removals: tool.fileDiff.removals,
          },
        }
      : {}),
  };
}

function detailKind(kind: NormalizedToolCall["kind"]): AppServerThreadActivityDetail["kind"] {
  if (kind === "command") return "command";
  if (kind === "write") return "write";
  return "read";
}

function activityStatus(status: NormalizedToolStatus): AppServerThreadActivityStatus {
  return status === "pending" ? "in_progress" : status;
}

function threadStatus(status: NormalizedThreadActivity | undefined): AppServerThreadStatus {
  if (status === "active") return "active";
  if (status === "unknown") return "unknown";
  return "idle";
}
