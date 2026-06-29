import type {
  HandoffTaskGroupingMode,
  HandoffTaskMessagingAttachmentMode,
  HandoffTaskSeedMode,
  HandoffTaskToolArgs,
  HandoffTaskWorkspaceMode,
  MoveThreadWorkspaceToolArgs,
  PwrAgentThreadOrchestrationOperationName,
  PwrAgentThreadOrchestrationRequest,
  PwrAgentThreadOrchestrationResponse,
  SendMessageToThreadToolArgs,
} from "@pwragent/shared";
import {
  HANDOFF_TASK_GROUPING_MODES,
  HANDOFF_TASK_MESSAGING_ATTACHMENT_MODES,
  HANDOFF_TASK_SEED_MODES,
  HANDOFF_TASK_WORKSPACE_MODES,
  PWRAGENT_THREAD_ORCHESTRATION_OPERATION_NAMES,
  PWRAGENT_TOOL_NAMESPACE,
} from "@pwragent/shared";
import type {
  AgentToolDefinition,
  AgentToolDispatchResult,
} from "./agent-tool-definition.js";
import {
  agentToolFailure,
  agentToolSuccess,
} from "./agent-tool-definition.js";
import { AgentToolRouter } from "./agent-tool-router.js";

export const PWRAGENT_THREAD_ORCHESTRATION_UNAVAILABLE_MESSAGE =
  "PwrAgent thread handoff tools are not available.";

const MOVE_THREAD_WORKSPACE_DIRECTIONS = [
  "local-to-worktree",
  "worktree-to-local",
] as const;

const MOVE_THREAD_WORKSPACE_STRATEGIES = [
  "move-branch",
  "detached-changes",
  "new-branch",
] as const;

export type PwrAgentThreadOrchestrationHandler = (
  request: PwrAgentThreadOrchestrationRequest,
) =>
  | PwrAgentThreadOrchestrationResponse
  | Promise<PwrAgentThreadOrchestrationResponse>;

export function buildPwrAgentThreadOrchestrationToolRouter(
  handler: PwrAgentThreadOrchestrationHandler | undefined,
  options: { namespace?: string; unsupportedMessage?: string } = {},
): AgentToolRouter {
  return new AgentToolRouter(
    buildPwrAgentThreadOrchestrationToolDefinitions(handler, {
      namespace: options.namespace,
    }),
    {
      unsupportedMessage:
        options.unsupportedMessage ?? "Unsupported PwrAgent thread handoff tool.",
    },
  );
}

export function buildPwrAgentThreadOrchestrationToolDefinitions(
  handler: PwrAgentThreadOrchestrationHandler | undefined,
  options: { namespace?: string } = {},
): AgentToolDefinition<PwrAgentThreadOrchestrationOperationName>[] {
  return PWRAGENT_THREAD_ORCHESTRATION_OPERATION_NAMES.map((operation) => ({
    namespace: options.namespace ?? PWRAGENT_TOOL_NAMESPACE,
    name: operation,
    description: descriptionForOperation(operation),
    inputSchema: inputSchemaForOperation(operation),
    deferLoading: false,
    dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: PWRAGENT_THREAD_ORCHESTRATION_UNAVAILABLE_MESSAGE,
        });
      }
      const normalizedArgs = normalizeArgsForOperation(operation, args);
      if (!normalizedArgs) {
        return agentToolFailure({
          code: "invalid_arguments",
          message: invalidArgumentsMessageForOperation(operation),
        });
      }
      const response = await handler({
        operation,
        context: {
          backend: context.backend,
          threadId: context.threadId,
          callId: context.callId,
          turnId: context.turnId,
        },
        args: normalizedArgs,
      } as PwrAgentThreadOrchestrationRequest);
      return threadOrchestrationResponseToAgentToolResult(response);
    },
  }));
}

function descriptionForOperation(
  operation: PwrAgentThreadOrchestrationOperationName,
): string {
  switch (operation) {
    case "handoff_task":
      return "Create and start a new PwrAgent Agent thread for a delegated task. Use this when the user asks to hand off or delegate work to a new thread. Omitted settings inherit from the invoking Agent turn. Clean new-thread handoff is the default; use seedMode=fork only when the user asks to fork this thread. Workspace-backed handoffs default to workspaceMode=new_worktree. Use groupingMode=subthread for related follow-up work, backports, or forward-ports that should stay grouped under the current thread; combine it with workspaceMode=new_worktree and branchName=<existing base ref> such as origin/main when the related work should start from another branch. Use workspaceMode=same_workspace only when the user explicitly asks to share the caller's exact workspace. Use workspaceMode=project_local only when the delegated thread should run in the project's primary checkout instead of a managed worktree. Handoff startup can take several minutes while a worktree or Codex environment is prepared; if this call appears slow or uncertain, do not call handoff_task again. Use search_threads or get_thread_status and inspect pendingHandoffs until a threadId appears or the handoff reports failed.";
    case "move_thread_workspace":
      return "Move the current PwrAgent thread runtime workspace after the invoking turn reaches a terminal boundary. Use this when the user asks to continue this same thread from an isolated worktree instead of creating a child handoff thread. The operation is path-keyed: pass sourcePath when the thread has multiple linked directories or when the intended workspace is not obvious. The tool returns a pending workspaceMoveId and stop-and-wait guidance; after the current turn ends, PwrAgent performs the move, updates future-turn cwd metadata, and starts a same-thread continuation with the result. Do not keep editing after a successful call in the invoking turn; wait for the continuation or inspect get_thread_status pendingWorkspaceMoves.";
    case "send_message_to_thread":
      return "Send a follow-up prompt to another existing PwrAgent thread. Use search_threads or read_thread first when the target threadId is unknown. Do not use this for the current thread; reply normally instead.";
  }
}

function inputSchemaForOperation(
  operation: PwrAgentThreadOrchestrationOperationName,
): Record<string, unknown> {
  switch (operation) {
    case "handoff_task":
      return {
        type: "object",
        additionalProperties: false,
        required: ["task"],
        properties: {
          task: {
            type: "string",
            description:
              "The concrete task for the created thread to perform. Include the user's requested work, not the parent transcript.",
          },
          title: {
            type: "string",
            description:
              "Optional short title for the created thread or handoff task.",
          },
          context: {
            type: "string",
            description:
              "Optional bounded context the parent Agent wants to include in the created thread's first prompt.",
          },
          seedMode: {
            type: "string",
            enum: HANDOFF_TASK_SEED_MODES,
            description:
              "`clean` starts a fresh thread and is the default. `fork` copies the current thread transcript and should be used only when the user explicitly asks to fork this thread.",
          },
          groupingMode: {
            type: "string",
            enum: HANDOFF_TASK_GROUPING_MODES,
            description:
              "`none` leaves the created thread ungrouped and is the default. `subthread` groups it under the invoking thread only when the user asks for a sub-thread.",
          },
          workspaceMode: {
            type: "string",
            enum: HANDOFF_TASK_WORKSPACE_MODES,
            description:
              "`new_worktree` requests an isolated Git worktree and is the default for workspace-backed handoffs; set branchName to an existing base ref such as `origin/master` when the user asks for a specific source branch. `same_workspace` shares the caller's exact cwd and is valid only with groupingMode=subthread. `project_local` uses the project's primary/local checkout. `none` allows a no-workspace thread. `same` is a legacy alias for `same_workspace`.",
          },
          messagingAttachment: {
            type: "string",
            enum: HANDOFF_TASK_MESSAGING_ATTACHMENT_MODES,
            description:
              "Whether to attach the created thread to the current messaging location. Defaults to `auto` for messaging-originated turns and `none` otherwise.",
          },
          backend: { type: "string" },
          model: { type: "string" },
          reasoningEffort: { type: "string" },
          serviceTier: { type: "string" },
          fastMode: { type: "boolean" },
          executionMode: { type: "string" },
          approvalPolicy: { type: "string" },
          sandbox: { type: "string" },
          branchName: {
            type: "string",
            description:
              "Optional existing base branch/ref for workspaceMode=new_worktree, for example `origin/master`. This is not the new feature branch name; tell the delegated thread to create or switch to its work branch in the task text.",
          },
        },
      };
    case "move_thread_workspace":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          backend: {
            type: "string",
            description:
              "Optional backend override. Omitted defaults to the invoking thread backend; the first implementation supports Codex self-move only.",
          },
          direction: {
            type: "string",
            enum: MOVE_THREAD_WORKSPACE_DIRECTIONS,
            description:
              "`local-to-worktree` is the default and first supported direction. `worktree-to-local` is reserved for compatible backends and may be rejected until implemented.",
          },
          strategy: {
            type: "string",
            enum: MOVE_THREAD_WORKSPACE_STRATEGIES,
            description:
              "Optional workspace handoff branch strategy using the existing PwrAgent workspace handoff vocabulary.",
          },
          repositoryPath: {
            type: "string",
            description:
              "Repository/local checkout path that owns the worktree relationship.",
          },
          sourcePath: {
            type: "string",
            description:
              "Current workspace path to move. Provide this when the thread has multiple linked directories or the intended source path is not obvious.",
          },
          sourceBranch: { type: "string" },
          leaveLocalBranch: {
            type: "string",
            description:
              "Branch/ref to leave checked out in the local checkout when moving the current branch to a worktree.",
          },
          newBranchName: {
            type: "string",
            description:
              "Optional new branch name for the workspace handoff when strategy=new-branch.",
          },
        },
      };
    case "send_message_to_thread":
      return {
        type: "object",
        additionalProperties: false,
        required: ["backend", "threadId", "prompt"],
        properties: {
          backend: {
            type: "string",
            description: "Backend that owns the target thread.",
          },
          threadId: {
            type: "string",
            description: "Existing target thread id that should receive the prompt.",
          },
          prompt: {
            type: "string",
            description:
              "The follow-up message to send as a new turn in the target thread.",
          },
          model: { type: "string" },
          reasoningEffort: { type: "string" },
          serviceTier: { type: "string" },
          fastMode: { type: "boolean" },
          executionMode: { type: "string" },
          approvalPolicy: { type: "string" },
          sandbox: { type: "string" },
        },
      };
  }
}

function normalizeArgsForOperation(
  operation: PwrAgentThreadOrchestrationOperationName,
  args: Record<string, unknown>,
):
  | HandoffTaskToolArgs
  | MoveThreadWorkspaceToolArgs
  | SendMessageToThreadToolArgs
  | undefined {
  switch (operation) {
    case "handoff_task":
      return normalizeHandoffTaskArgs(args);
    case "move_thread_workspace":
      return normalizeMoveThreadWorkspaceArgs(args);
    case "send_message_to_thread":
      return normalizeSendMessageToThreadArgs(args);
  }
}

function invalidArgumentsMessageForOperation(
  operation: PwrAgentThreadOrchestrationOperationName,
): string {
  switch (operation) {
    case "handoff_task":
      return "handoff_task requires a non-empty task string.";
    case "move_thread_workspace":
      return "move_thread_workspace accepts only known direction/strategy values and non-empty string fields.";
    case "send_message_to_thread":
      return "send_message_to_thread requires non-empty backend, threadId, and prompt strings.";
  }
}

function normalizeHandoffTaskArgs(
  args: Record<string, unknown>,
): HandoffTaskToolArgs | undefined {
  const task = readTrimmedString(args.task);
  if (!task) {
    return undefined;
  }
  return {
    task,
    ...(readTrimmedString(args.title)
      ? { title: readTrimmedString(args.title) }
      : {}),
    ...(readTrimmedString(args.context)
      ? { context: readTrimmedString(args.context) }
      : {}),
    ...(readChoice(args.seedMode, HANDOFF_TASK_SEED_MODES)
      ? {
          seedMode: readChoice(
            args.seedMode,
            HANDOFF_TASK_SEED_MODES,
          ) as HandoffTaskSeedMode,
        }
      : {}),
    ...(readChoice(args.groupingMode, HANDOFF_TASK_GROUPING_MODES)
      ? {
          groupingMode: readChoice(
            args.groupingMode,
            HANDOFF_TASK_GROUPING_MODES,
          ) as HandoffTaskGroupingMode,
        }
      : {}),
    ...(readChoice(args.workspaceMode, HANDOFF_TASK_WORKSPACE_MODES)
      ? {
          workspaceMode: readChoice(
            args.workspaceMode,
            HANDOFF_TASK_WORKSPACE_MODES,
          ) as HandoffTaskWorkspaceMode,
        }
      : {}),
    ...(readChoice(
      args.messagingAttachment,
      HANDOFF_TASK_MESSAGING_ATTACHMENT_MODES,
    )
      ? {
          messagingAttachment: readChoice(
            args.messagingAttachment,
            HANDOFF_TASK_MESSAGING_ATTACHMENT_MODES,
          ) as HandoffTaskMessagingAttachmentMode,
        }
      : {}),
    ...(readTrimmedString(args.backend)
      ? { backend: readTrimmedString(args.backend) as HandoffTaskToolArgs["backend"] }
      : {}),
    ...(readTrimmedString(args.model)
      ? { model: readTrimmedString(args.model) }
      : {}),
    ...(readTrimmedString(args.reasoningEffort)
      ? { reasoningEffort: readTrimmedString(args.reasoningEffort) }
      : {}),
    ...(readTrimmedString(args.serviceTier)
      ? { serviceTier: readTrimmedString(args.serviceTier) }
      : {}),
    ...(typeof args.fastMode === "boolean" ? { fastMode: args.fastMode } : {}),
    ...(readTrimmedString(args.executionMode)
      ? {
          executionMode: readTrimmedString(
            args.executionMode,
          ) as HandoffTaskToolArgs["executionMode"],
        }
      : {}),
    ...(readTrimmedString(args.approvalPolicy)
      ? { approvalPolicy: readTrimmedString(args.approvalPolicy) }
      : {}),
    ...(readTrimmedString(args.sandbox)
      ? { sandbox: readTrimmedString(args.sandbox) }
      : {}),
    ...(readTrimmedString(args.branchName)
      ? { branchName: readTrimmedString(args.branchName) }
      : {}),
  };
}

function normalizeSendMessageToThreadArgs(
  args: Record<string, unknown>,
): SendMessageToThreadToolArgs | undefined {
  const backend = readTrimmedString(args.backend);
  const threadId = readTrimmedString(args.threadId);
  const prompt = readTrimmedString(args.prompt);
  if (!backend || !threadId || !prompt) {
    return undefined;
  }
  return {
    backend: backend as SendMessageToThreadToolArgs["backend"],
    threadId,
    prompt,
    ...(readTrimmedString(args.model)
      ? { model: readTrimmedString(args.model) }
      : {}),
    ...(readTrimmedString(args.reasoningEffort)
      ? { reasoningEffort: readTrimmedString(args.reasoningEffort) }
      : {}),
    ...(readTrimmedString(args.serviceTier)
      ? { serviceTier: readTrimmedString(args.serviceTier) }
      : {}),
    ...(typeof args.fastMode === "boolean" ? { fastMode: args.fastMode } : {}),
    ...(readTrimmedString(args.executionMode)
      ? {
          executionMode: readTrimmedString(
            args.executionMode,
          ) as SendMessageToThreadToolArgs["executionMode"],
        }
      : {}),
    ...(readTrimmedString(args.approvalPolicy)
      ? { approvalPolicy: readTrimmedString(args.approvalPolicy) }
      : {}),
    ...(readTrimmedString(args.sandbox)
      ? { sandbox: readTrimmedString(args.sandbox) }
      : {}),
  };
}

function normalizeMoveThreadWorkspaceArgs(
  args: Record<string, unknown>,
): MoveThreadWorkspaceToolArgs | undefined {
  const direction =
    args.direction === undefined
      ? "local-to-worktree"
      : readChoice(args.direction, MOVE_THREAD_WORKSPACE_DIRECTIONS);
  if (!direction) {
    return undefined;
  }
  const strategy =
    args.strategy === undefined
      ? undefined
      : readChoice(args.strategy, MOVE_THREAD_WORKSPACE_STRATEGIES);
  if (args.strategy !== undefined && !strategy) {
    return undefined;
  }

  const optionalStringFields = [
    "backend",
    "repositoryPath",
    "sourcePath",
    "sourceBranch",
    "leaveLocalBranch",
    "newBranchName",
  ] as const;
  for (const field of optionalStringFields) {
    if (Object.hasOwn(args, field) && !readTrimmedString(args[field])) {
      return undefined;
    }
  }
  const backend = readTrimmedString(args.backend);
  const repositoryPath = readTrimmedString(args.repositoryPath);
  const sourcePath = readTrimmedString(args.sourcePath);
  const sourceBranch = readTrimmedString(args.sourceBranch);
  const leaveLocalBranch = readTrimmedString(args.leaveLocalBranch);
  const newBranchName = readTrimmedString(args.newBranchName);

  return {
    direction,
    ...(strategy ? { strategy } : {}),
    ...(backend ? { backend: backend as MoveThreadWorkspaceToolArgs["backend"] } : {}),
    ...(repositoryPath ? { repositoryPath } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(sourceBranch ? { sourceBranch } : {}),
    ...(leaveLocalBranch ? { leaveLocalBranch } : {}),
    ...(newBranchName ? { newBranchName } : {}),
  };
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readChoice<TValue extends string>(
  value: unknown,
  choices: readonly TValue[],
): TValue | undefined {
  return typeof value === "string" && choices.includes(value as TValue)
    ? (value as TValue)
    : undefined;
}

function threadOrchestrationResponseToAgentToolResult(
  response: PwrAgentThreadOrchestrationResponse,
): AgentToolDispatchResult {
  if (response.ok) {
    return agentToolSuccess(response.data);
  }
  return agentToolFailure({
    code: response.error.code,
    message: response.error.message,
    data: response.error.data,
  });
}
