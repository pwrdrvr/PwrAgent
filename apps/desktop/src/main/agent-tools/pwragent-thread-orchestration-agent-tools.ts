import type {
  HandoffTaskGroupingMode,
  HandoffTaskMessagingAttachmentMode,
  HandoffTaskSeedMode,
  HandoffTaskToolArgs,
  HandoffTaskWorkspaceMode,
  PwrAgentThreadOrchestrationOperationName,
  PwrAgentThreadOrchestrationRequest,
  PwrAgentThreadOrchestrationResponse,
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
      const normalizedArgs = normalizeHandoffTaskArgs(args);
      if (!normalizedArgs) {
        return agentToolFailure({
          code: "invalid_arguments",
          message: "handoff_task requires a non-empty task string.",
        });
      }
      const response = await handler({
        operation,
        context: {
          backend: context.backend,
          threadId: context.threadId,
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
      return "Create and start a new PwrAgent Agent thread for a delegated task. Use this when the user asks to hand off or delegate work to a new thread. Omitted settings inherit from the invoking Agent turn. Clean new-thread handoff is the default; use seedMode=fork only when the user asks to fork this thread, and groupingMode=subthread only when the user asks for a sub-thread.";
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
              "`same` inherits the current workspace and is the default. `new_worktree` requests an isolated Git worktree. `none` allows a no-workspace thread.",
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
              "Optional branch name for an explicit new-worktree handoff.",
          },
        },
      };
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
