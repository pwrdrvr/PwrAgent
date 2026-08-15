import type {
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
  AttachThreadDirectoryToolArgs,
  AttachThreadDirectoryWorkspaceMode,
  AttachThreadDirectoryWorktreeBranchMode,
  HandoffTaskGroupingMode,
  HandoffTaskMessagingAttachmentMode,
  HandoffTaskSeedMode,
  HandoffTaskToolArgs,
  HandoffTaskWorkspaceMode,
  DetachThreadDirectoryToolArgs,
  MoveThreadWorkspaceToolArgs,
  PwrAgentThreadOrchestrationOperationName,
  PwrAgentThreadOrchestrationRequest,
  PwrAgentThreadOrchestrationResponse,
  SendMessageToThreadToolArgs,
  SteerThreadToolArgs,
  StartReviewToolArgs,
  StopThreadToolArgs,
} from "@pwragent/shared";
import {
  ATTACH_THREAD_DIRECTORY_WORKSPACE_MODES,
  ATTACH_THREAD_DIRECTORY_WORKTREE_BRANCH_MODES,
  DEFAULT_MOVE_THREAD_WORKSPACE_STRATEGY,
  HANDOFF_TASK_GROUPING_MODES,
  HANDOFF_TASK_MESSAGING_ATTACHMENT_MODES,
  HANDOFF_TASK_SEED_MODES,
  HANDOFF_TASK_WORKSPACE_MODES,
  PWRAGENT_THREAD_ORCHESTRATION_OPERATION_NAMES,
  PWRAGENT_TOOL_NAMESPACE,
  THREAD_WORKSPACE_HANDOFF_DIRECTIONS,
  THREAD_WORKSPACE_HANDOFF_STRATEGIES,
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

export type PwrAgentThreadOrchestrationHandler = (
  request: PwrAgentThreadOrchestrationRequest,
) =>
  | PwrAgentThreadOrchestrationResponse
  | Promise<PwrAgentThreadOrchestrationResponse>;

export type PwrAgentFederatedThreadMessageRequest = {
  backend: SendMessageToThreadToolArgs["backend"];
  threadId: SendMessageToThreadToolArgs["threadId"];
  instanceId?: SendMessageToThreadToolArgs["instanceId"];
  resolutionMode?: "remembered_only" | "discover_only";
  input: AppServerTurnInputItem[];
  messageOrigin: AppServerThreadMessageOrigin;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
  executionMode?: SendMessageToThreadToolArgs["executionMode"];
  approvalPolicy?: string;
  sandbox?: string;
};

export type PwrAgentFederatedThreadMessageResult = {
  backend: SendMessageToThreadToolArgs["backend"];
  threadId: SendMessageToThreadToolArgs["threadId"];
  turnId: string;
  queueStatus?: "queued";
  queueEntryId?: string;
  title?: string;
  instanceId: string;
  instanceLabel: string;
};

export type PwrAgentFederatedThreadMessageHandler = (
  request: PwrAgentFederatedThreadMessageRequest,
) => Promise<PwrAgentFederatedThreadMessageResult | undefined>;

export type PwrAgentFederatedThreadControlRequest = {
  operation: "steer" | "stop";
  backend: StopThreadToolArgs["backend"];
  threadId: StopThreadToolArgs["threadId"];
  instanceId?: StopThreadToolArgs["instanceId"];
  resolutionMode?: "remembered_only" | "discover_only";
  requestId: string;
  expectedTurnId?: string;
  input?: AppServerTurnInputItem[];
  messageOrigin?: AppServerThreadMessageOrigin;
};

export type PwrAgentFederatedThreadControlResult = {
  backend: StopThreadToolArgs["backend"];
  threadId: StopThreadToolArgs["threadId"];
  turnId: string;
  disposition: "interrupted" | "steered";
  idempotentReplay?: boolean;
  instanceId: string;
  instanceLabel: string;
};

export type PwrAgentFederatedThreadControlHandler = (
  request: PwrAgentFederatedThreadControlRequest,
) => Promise<PwrAgentFederatedThreadControlResult | undefined>;

export class PwrAgentFederatedThreadMessageError extends Error {
  constructor(
    readonly code:
      | "ambiguous_owner"
      | "internal_error"
      | "invalid_arguments"
      | "no_active_turn"
      | "peer_unavailable"
      | "stale_target"
      | "unsupported_backend"
      | "unsupported_capability",
    message: string,
  ) {
    super(message);
    this.name = "PwrAgentFederatedThreadMessageError";
  }
}

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
      return "Create a PwrAgent-managed thread for delegated work. Prefer this to backend spawning unless the user requests it or needs an unsupported feature. Agent settings inherit from the current turn. Same-project handoffs create grouped subthreads in new worktrees by default. When the user names another local project, pass its path as cwd. Also pass cwd when the user links or references a local directory. Never put the target path only in task or context. For an isolated worktree in that project, set workspaceMode=new_worktree. Set branchName only to an existing base ref. Omit cwd only to inherit the current project. Cross-project handoffs are not grouped. Use fork or same_workspace only when the user requests them. Use project_local for the project checkout. workspaceMode=none creates an unscoped scratch workspace. Do not use none as a fallback for work in a named project. Provider overrides need a registered backend and exact model ID. Do not retry while startup is pending. Inspect pendingHandoffs and return threadLink verbatim.";
    case "attach_thread_directory":
      return "Attach another Git directory to the current PwrAgent thread. Use this for user-requested cross-project work. Omit backend for the current thread. Use workspaceMode=local for the repository or new_worktree for a managed worktree. Default Access requires confirmation for an untrusted path. This tool does not change the primary cwd. Use detach_thread_directory to remove a temporary link.";
    case "detach_thread_directory":
      return "Detach a secondary directory from the current PwrAgent thread. Use this only when the user requests cleanup. You cannot detach the primary provider/runtime cwd. Pass directoryId when known. Otherwise, pass path or worktreePath from get_thread_status.";
    case "move_thread_workspace":
      return "Move the current thread workspace after this turn ends. Use this to move this thread to an isolated worktree. Do not create a child thread. Pass sourcePath when the thread has multiple directories or the source is unclear. After success, stop work and end the turn. PwrAgent moves the workspace, updates cwd, reconnects ACP when necessary, and starts a continuation. Check pendingWorkspaceMoves only after the turn.";
    case "send_message_to_thread":
      return "Send a follow-up as a new turn to another PwrAgent thread. If a turn is active, PwrAgent queues the follow-up. Use steer_thread for guidance to the active turn. Use stop_thread for an urgent interruption. Find an unknown thread with search_threads or read_thread. Pass instanceId from a remote result when available. Set includeRemote=false for local resolution. Reply normally to the current thread. Return threadLink verbatim.";
    case "steer_thread":
      return "Advise another PwrAgent thread. PwrAgent steers a matching active turn at the next tool boundary. If the target is idle or changes before admission, PwrAgent preserves the guidance. It starts a follow-up turn or queues one behind the current turn. The result disposition is steered, started, or queued, so this tool never reports a fallback as steered. Use send_message_to_thread when a distinct new turn is required and stop_thread for an urgent interruption. Pass instanceId when known. Set includeRemote=false for local resolution. Reuse requestId only to retry the same steer. This thread cannot steer itself.";
    case "stop_thread":
      return "Stop the active turn on another PwrAgent thread immediately. Use this only for an urgent interruption. This tool interrupts the backend and does not queue text. The owner rejects a stale expectedTurnId. Pass instanceId when known. Set includeRemote=false for local resolution. Reuse requestId only to retry the same stop. This thread cannot stop itself.";
    case "start_review":
      return "Schedule a review of this PwrAgent thread after the current turn ends successfully. Use this only after an explicit operator request. Select one target type. After success, stop work and end the turn. Do not poll or call this tool again.";
  }
}

function inputSchemaForOperation(
  operation: PwrAgentThreadOrchestrationOperationName,
): Record<string, unknown> {
  switch (operation) {
    case "attach_thread_directory":
      return {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          backend: {
            type: "string",
            description:
              "Optional backend override. Omit it for the current thread. This implementation supports only the current thread.",
          },
          path: {
            type: "string",
            description:
              "Repository/local checkout path to attach, or to use as the parent repo for a new worktree. In Default Access, untrusted paths require operator confirmation first.",
          },
          workspaceMode: {
            type: "string",
            enum: ATTACH_THREAD_DIRECTORY_WORKSPACE_MODES,
            description:
              "`local` attaches the repository and is the default. `new_worktree` creates and attaches a managed worktree after PwrAgent trusts the source path.",
          },
          branchName: {
            type: "string",
            description:
              "Optional existing base branch/ref for workspaceMode=new_worktree, for example `origin/main`. This is not a new feature branch name.",
          },
          worktreeBranchMode: {
            type: "string",
            enum: ATTACH_THREAD_DIRECTORY_WORKTREE_BRANCH_MODES,
            description:
              "Whether the allocated worktree should be checked out on an attached branch or as a detached HEAD. Defaults to detached.",
          },
        },
      };
    case "detach_thread_directory":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          backend: {
            type: "string",
            description:
              "Optional backend override. Omit it for the current thread. This implementation supports only the current thread.",
          },
          directoryId: {
            type: "string",
            description: "Exact linked-directory id to detach when known.",
          },
          path: {
            type: "string",
            description: "Repository/local checkout path to detach.",
          },
          worktreePath: {
            type: "string",
            description: "Managed worktree path to detach.",
          },
        },
      };
    case "handoff_task":
      return {
        type: "object",
        additionalProperties: false,
        required: ["task"],
        properties: {
          task: {
            type: "string",
            description:
              "Give the new thread a concrete task. Include the user's requested work, not the parent transcript. Select the workspace with cwd and workspaceMode.",
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
              "`clean` starts a new thread and is the default. `fork` copies this transcript. Use `fork` only when the user requests it.",
          },
          groupingMode: {
            type: "string",
            enum: HANDOFF_TASK_GROUPING_MODES,
            description:
              "`subthread` is the same-project default. `none` does not group the thread. Cross-project handoffs are never grouped.",
          },
          workspaceMode: {
            type: "string",
            enum: HANDOFF_TASK_WORKSPACE_MODES,
            description:
              "`new_worktree` is the default for workspace handoffs. Combine it with cwd when the user selects another local project. `same_workspace` requires groupingMode=subthread. `project_local` uses the selected project checkout. `none` creates an unscoped scratch workspace. Do not use `none` as a fallback for work in a named project. `same` aliases `same_workspace`.",
          },
          cwd: {
            type: "string",
            description:
              "Filesystem path of the workspace source. This field is required when the user names another local project. It is also required when the user links or references a local directory. Combine it with workspaceMode=new_worktree for an isolated worktree. Omit it only to inherit the current project. A path in task or context does not select cwd.",
          },
          messagingAttachment: {
            type: "string",
            enum: HANDOFF_TASK_MESSAGING_ATTACHMENT_MODES,
            description:
              "Whether to attach the created thread to the current messaging location. Defaults to `auto` for messaging-originated turns and `none` otherwise.",
          },
          backend: {
            type: "string",
            description:
              "Registered backend override. Omit it to inherit the current backend. Use `acp:grok` for Grok.",
          },
          model: {
            type: "string",
            description:
              "Exact model ID for the selected backend (Grok: `grok-4.5`).",
          },
          reasoningEffort: { type: "string" },
          serviceTier: { type: "string" },
          fastMode: { type: "boolean" },
          executionMode: { type: "string" },
          approvalPolicy: { type: "string" },
          sandbox: { type: "string" },
          branchName: {
            type: "string",
            description:
              "Existing base ref for workspaceMode=new_worktree, such as `origin/main`. PwrAgent resolves this ref in cwd when you provide cwd. This is not a new branch name. Put branch creation in task.",
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
              "Optional backend override. Omit it for the current backend. A same-thread move must use the current backend.",
          },
          direction: {
            type: "string",
            enum: THREAD_WORKSPACE_HANDOFF_DIRECTIONS,
            description:
              "`local-to-worktree` is the default and first supported direction. `worktree-to-local` is reserved for compatible backends and may be rejected until implemented.",
          },
          strategy: {
            type: "string",
            enum: THREAD_WORKSPACE_HANDOFF_STRATEGIES,
            description:
              `Optional workspace handoff branch strategy using the existing PwrAgent workspace handoff vocabulary. Defaults to ${DEFAULT_MOVE_THREAD_WORKSPACE_STRATEGY} unless leaveLocalBranch or newBranchName implies a branch strategy.`,
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
            description:
              "Backend type for the target thread. PwrAgent resolves its owning instance automatically.",
          },
          threadId: {
            type: "string",
            description: "Existing target thread id that should receive the prompt.",
          },
          instanceId: {
            type: "string",
            description:
              "Owning remote instance id from create_instance_thread, search_federation_threads, or a cross-instance thread link. Omit for local threads or when unknown.",
          },
          includeRemote: {
            type: "boolean",
            description:
              "Defaults to true. Set false to restrict resolution to the local instance.",
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
    case "steer_thread":
      return threadTurnControlInputSchema({ prompt: true });
    case "stop_thread":
      return threadTurnControlInputSchema({ prompt: false });
    case "start_review":
      return {
        type: "object",
        additionalProperties: false,
        required: ["target"],
        properties: {
          cwd: {
            type: "string",
            description:
              "Optional linked workspace to review when the thread has multiple directories.",
          },
          target: {
            type: "object",
            additionalProperties: false,
            required: ["type"],
            properties: {
              type: {
                type: "string",
                enum: [
                  "uncommittedChanges",
                  "baseBranch",
                  "commit",
                  "custom",
                ],
              },
              branch: { type: "string" },
              sha: { type: "string" },
              title: {
                anyOf: [{ type: "string" }, { type: "null" }],
              },
              instructions: { type: "string" },
            },
          },
        },
      };
  }
}

function normalizeArgsForOperation(
  operation: PwrAgentThreadOrchestrationOperationName,
  args: Record<string, unknown>,
):
  | AttachThreadDirectoryToolArgs
  | DetachThreadDirectoryToolArgs
  | HandoffTaskToolArgs
  | MoveThreadWorkspaceToolArgs
  | SendMessageToThreadToolArgs
  | SteerThreadToolArgs
  | StartReviewToolArgs
  | StopThreadToolArgs
  | undefined {
  switch (operation) {
    case "attach_thread_directory":
      return normalizeAttachThreadDirectoryArgs(args);
    case "detach_thread_directory":
      return normalizeDetachThreadDirectoryArgs(args);
    case "handoff_task":
      return normalizeHandoffTaskArgs(args);
    case "move_thread_workspace":
      return normalizeMoveThreadWorkspaceArgs(args);
    case "send_message_to_thread":
      return normalizeSendMessageToThreadArgs(args);
    case "steer_thread":
      return normalizeSteerThreadArgs(args);
    case "stop_thread":
      return normalizeStopThreadArgs(args);
    case "start_review":
      return normalizeStartReviewArgs(args);
  }
}

function invalidArgumentsMessageForOperation(
  operation: PwrAgentThreadOrchestrationOperationName,
): string {
  switch (operation) {
    case "attach_thread_directory":
      return "attach_thread_directory requires a non-empty path and accepts only known workspaceMode/worktreeBranchMode values.";
    case "detach_thread_directory":
      return "detach_thread_directory requires at least one of directoryId, path, or worktreePath, and all provided string fields must be non-empty.";
    case "handoff_task":
      return "handoff_task requires a non-empty task string.";
    case "move_thread_workspace":
      return "move_thread_workspace accepts only known direction/strategy values and non-empty string fields.";
    case "send_message_to_thread":
      return "send_message_to_thread requires non-empty backend, threadId, and prompt strings.";
    case "steer_thread":
      return "steer_thread requires non-empty backend, threadId, requestId, and prompt strings; includeRemote must be boolean when supplied, and instanceId cannot be combined with includeRemote=false.";
    case "stop_thread":
      return "stop_thread requires non-empty backend, threadId, and requestId strings; includeRemote must be boolean when supplied, and instanceId cannot be combined with includeRemote=false.";
    case "start_review":
      return "start_review requires a valid structured target and non-empty target-specific fields.";
  }
}

function normalizeAttachThreadDirectoryArgs(
  args: Record<string, unknown>,
): AttachThreadDirectoryToolArgs | undefined {
  const directoryPath = readTrimmedString(args.path);
  if (!directoryPath) {
    return undefined;
  }
  const workspaceMode =
    args.workspaceMode === undefined
      ? undefined
      : readChoice(args.workspaceMode, ATTACH_THREAD_DIRECTORY_WORKSPACE_MODES);
  if (args.workspaceMode !== undefined && !workspaceMode) {
    return undefined;
  }
  const worktreeBranchMode =
    args.worktreeBranchMode === undefined
      ? undefined
      : readChoice(
          args.worktreeBranchMode,
          ATTACH_THREAD_DIRECTORY_WORKTREE_BRANCH_MODES,
        );
  if (args.worktreeBranchMode !== undefined && !worktreeBranchMode) {
    return undefined;
  }

  const optionalStringFields = ["backend", "branchName"] as const;
  for (const field of optionalStringFields) {
    if (Object.hasOwn(args, field) && !readTrimmedString(args[field])) {
      return undefined;
    }
  }

  const backend = readTrimmedString(args.backend);
  const branchName = readTrimmedString(args.branchName);
  return {
    path: directoryPath,
    ...(backend
      ? { backend: backend as AttachThreadDirectoryToolArgs["backend"] }
      : {}),
    ...(workspaceMode
      ? { workspaceMode: workspaceMode as AttachThreadDirectoryWorkspaceMode }
      : {}),
    ...(branchName ? { branchName } : {}),
    ...(worktreeBranchMode
      ? {
          worktreeBranchMode:
            worktreeBranchMode as AttachThreadDirectoryWorktreeBranchMode,
        }
      : {}),
  };
}

function normalizeDetachThreadDirectoryArgs(
  args: Record<string, unknown>,
): DetachThreadDirectoryToolArgs | undefined {
  const optionalStringFields = [
    "backend",
    "directoryId",
    "path",
    "worktreePath",
  ] as const;
  for (const field of optionalStringFields) {
    if (Object.hasOwn(args, field) && !readTrimmedString(args[field])) {
      return undefined;
    }
  }

  const backend = readTrimmedString(args.backend);
  const directoryId = readTrimmedString(args.directoryId);
  const directoryPath = readTrimmedString(args.path);
  const worktreePath = readTrimmedString(args.worktreePath);
  if (!directoryId && !directoryPath && !worktreePath) {
    return undefined;
  }

  return {
    ...(backend
      ? { backend: backend as DetachThreadDirectoryToolArgs["backend"] }
      : {}),
    ...(directoryId ? { directoryId } : {}),
    ...(directoryPath ? { path: directoryPath } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  };
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
    ...(readTrimmedString(args.cwd) ? { cwd: readTrimmedString(args.cwd) } : {}),
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
  const instanceId = readTrimmedString(args.instanceId);
  const prompt = readTrimmedString(args.prompt);
  if (!backend || !threadId || !prompt) {
    return undefined;
  }
  if (Object.hasOwn(args, "instanceId") && !instanceId) {
    return undefined;
  }
  if (
    (Object.hasOwn(args, "includeRemote")
      && typeof args.includeRemote !== "boolean")
    || (instanceId && args.includeRemote === false)
  ) {
    return undefined;
  }
  return {
    backend: backend as SendMessageToThreadToolArgs["backend"],
    threadId,
    ...(instanceId ? { instanceId } : {}),
    ...(typeof args.includeRemote === "boolean"
      ? { includeRemote: args.includeRemote }
      : {}),
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

function threadTurnControlInputSchema(
  options: { prompt: boolean },
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: options.prompt
      ? ["backend", "threadId", "requestId", "prompt"]
      : ["backend", "threadId", "requestId"],
    properties: {
      backend: {
        type: "string",
        description: "Backend type for the target thread.",
      },
      threadId: {
        type: "string",
        description: "Existing target thread id to control.",
      },
      instanceId: {
        type: "string",
        description:
          "Owning remote instance id when known. Omit for local threads or automatic ownership resolution.",
      },
      includeRemote: {
        type: "boolean",
        description:
          "Defaults to true. Set false to restrict resolution to the local instance.",
      },
      requestId: {
        type: "string",
        description:
          "Stable idempotency key. Reuse only to retry this exact action with identical arguments.",
      },
      expectedTurnId: {
        type: "string",
        description:
          options.prompt
            ? "Optional guard for inline steering. If that turn is no longer active, PwrAgent preserves the guidance as a follow-up instead."
            : "Optional compare-and-act guard. The action fails as stale if the owning instance reports another active turn.",
      },
      ...(options.prompt
        ? {
            prompt: {
              type: "string",
              description:
                "Guidance to deliver into the active turn at the next tool completion or message boundary.",
            },
          }
        : {}),
    },
  };
}

function normalizeStopThreadArgs(
  args: Record<string, unknown>,
): StopThreadToolArgs | undefined {
  return normalizeThreadTurnControlArgs(args, false);
}

function normalizeSteerThreadArgs(
  args: Record<string, unknown>,
): SteerThreadToolArgs | undefined {
  return normalizeThreadTurnControlArgs(args, true);
}

function normalizeThreadTurnControlArgs(
  args: Record<string, unknown>,
  promptRequired: false,
): StopThreadToolArgs | undefined;
function normalizeThreadTurnControlArgs(
  args: Record<string, unknown>,
  promptRequired: true,
): SteerThreadToolArgs | undefined;
function normalizeThreadTurnControlArgs(
  args: Record<string, unknown>,
  promptRequired: boolean,
): StopThreadToolArgs | SteerThreadToolArgs | undefined {
  const backend = readTrimmedString(args.backend);
  const threadId = readTrimmedString(args.threadId);
  const instanceId = readTrimmedString(args.instanceId);
  const requestId = readTrimmedString(args.requestId);
  const expectedTurnId = readTrimmedString(args.expectedTurnId);
  const prompt = readTrimmedString(args.prompt);
  if (!backend || !threadId || !requestId || (promptRequired && !prompt)) {
    return undefined;
  }
  if (
    (Object.hasOwn(args, "instanceId") && !instanceId)
    || (Object.hasOwn(args, "expectedTurnId") && !expectedTurnId)
    || (Object.hasOwn(args, "includeRemote")
      && typeof args.includeRemote !== "boolean")
    || (instanceId && args.includeRemote === false)
  ) {
    return undefined;
  }
  const target = {
    backend: backend as StopThreadToolArgs["backend"],
    threadId,
    ...(instanceId ? { instanceId } : {}),
    ...(typeof args.includeRemote === "boolean"
      ? { includeRemote: args.includeRemote }
      : {}),
    requestId,
    ...(expectedTurnId ? { expectedTurnId } : {}),
  };
  return promptRequired
    ? { ...target, prompt: prompt as string }
    : target;
}

function normalizeStartReviewArgs(
  args: Record<string, unknown>,
): StartReviewToolArgs | undefined {
  const targetRecord =
    args.target && typeof args.target === "object" && !Array.isArray(args.target)
      ? args.target as Record<string, unknown>
      : undefined;
  if (!targetRecord) {
    return undefined;
  }

  let target: StartReviewToolArgs["target"] | undefined;
  if (targetRecord.type === "uncommittedChanges") {
    target = { type: "uncommittedChanges" };
  } else if (targetRecord.type === "baseBranch") {
    const branch = readTrimmedString(targetRecord.branch);
    if (branch) {
      target = { type: "baseBranch", branch };
    }
  } else if (targetRecord.type === "commit") {
    const sha = readTrimmedString(targetRecord.sha);
    if (sha) {
      target = {
        type: "commit",
        sha,
        title: readTrimmedString(targetRecord.title) ?? null,
      };
    }
  } else if (targetRecord.type === "custom") {
    const instructions = readTrimmedString(targetRecord.instructions);
    if (instructions) {
      target = { type: "custom", instructions };
    }
  }
  if (!target) {
    return undefined;
  }

  const cwd = readTrimmedString(args.cwd);
  if (Object.hasOwn(args, "cwd") && !cwd) {
    return undefined;
  }
  return {
    target,
    ...(cwd ? { cwd } : {}),
  };
}

function normalizeMoveThreadWorkspaceArgs(
  args: Record<string, unknown>,
): MoveThreadWorkspaceToolArgs | undefined {
  const direction =
    args.direction === undefined
      ? "local-to-worktree"
      : readChoice(args.direction, THREAD_WORKSPACE_HANDOFF_DIRECTIONS);
  if (!direction) {
    return undefined;
  }
  const strategy =
    args.strategy === undefined
      ? undefined
      : readChoice(args.strategy, THREAD_WORKSPACE_HANDOFF_STRATEGIES);
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
