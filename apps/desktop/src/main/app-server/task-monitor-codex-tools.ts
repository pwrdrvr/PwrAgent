import type {
  AppServerBackendKind,
  CompleteMonitoringToolArgs,
  CreateMonitorDelegationToolArgs,
  InjectMonitorProgressToolArgs,
  TaskMonitorContext,
  TaskMonitorOperationName,
  TaskMonitorRequest,
  TaskMonitorResponse,
} from "@pwragent/shared";
import {
  DEFAULT_TASK_MONITOR_MODEL,
  DEFAULT_TASK_MONITOR_POLL_INTERVAL_SECONDS,
  DEFAULT_TASK_MONITOR_REASONING_EFFORT,
  TASK_MONITOR_TOOL_NAMESPACE,
  isTaskMonitorOperationName,
} from "@pwragent/shared";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
} from "@pwrdrvr/codex-app-server-protocol/v2";

export type TaskMonitorHandler = (
  request: TaskMonitorRequest,
) => TaskMonitorResponse | Promise<TaskMonitorResponse>;

export function buildTaskMonitorDynamicToolSpecs(): DynamicToolSpec[] {
  return [
    {
      namespace: TASK_MONITOR_TOOL_NAMESPACE,
      name: "create_monitor_delegation",
      description:
        "Create a lightweight subagent monitoring delegation for long-running async work such as GitHub Actions, CI/CD, PR checks, deployments, builds, lint, or test jobs. Use this instead of polling from the parent agent when the task may take more than one short status check. Call this before spawning a monitor agent; then pass the returned prompt to a cheap mini/non-thinking or low-reasoning subagent model.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
          monitorContext: { type: "string" },
          pollIntervalSeconds: { type: "number", minimum: 5 },
          preferredModel: { type: "string" },
          preferredReasoningEffort: { type: "string" },
          finalHandoffPrompt: { type: "string" },
        },
        required: ["task"],
        additionalProperties: false,
      },
      deferLoading: false,
    },
    {
      namespace: TASK_MONITOR_TOOL_NAMESPACE,
      name: "inject_progress",
      description:
        "Inject a concise progress update from a monitor subagent into the parent PwrAgent thread without starting or waking a parent turn.",
      inputSchema: {
        type: "object",
        properties: {
          monitorId: { type: "string" },
          message: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "running", "blocked", "failed"],
          },
        },
        required: ["monitorId", "message"],
        additionalProperties: false,
      },
      deferLoading: false,
    },
    {
      namespace: TASK_MONITOR_TOOL_NAMESPACE,
      name: "complete_monitoring",
      description:
        "Finish a monitor delegation, inject the final result, and by default trigger exactly one parent turn with the final context.",
      inputSchema: {
        type: "object",
        properties: {
          monitorId: { type: "string" },
          outcome: {
            type: "string",
            enum: ["success", "failure", "cancelled"],
          },
          summary: { type: "string" },
          details: { type: "string" },
          triggerParentTurn: { type: "boolean" },
        },
        required: ["monitorId", "outcome", "summary"],
        additionalProperties: false,
      },
      deferLoading: false,
    },
  ];
}

export function readTaskMonitorDynamicToolCall(request: {
  method: string;
  params: Record<string, unknown>;
}): DynamicToolCallParams | undefined {
  if (request.method !== "item/tool/call") {
    return undefined;
  }
  const call = request.params;
  const threadId = readString(call.threadId);
  const turnId = readString(call.turnId) ?? "";
  const callId = readString(call.callId) ?? readString(call.requestId);
  const tool = readString(call.tool);
  const namespace =
    typeof call.namespace === "string" || call.namespace === null
      ? call.namespace
      : undefined;
  if (!threadId || !callId || !tool || namespace === undefined) {
    return undefined;
  }
  return {
    threadId,
    turnId,
    callId,
    namespace,
    tool,
    arguments: (call.arguments ?? null) as DynamicToolCallParams["arguments"],
  };
}

export function isTaskMonitorDynamicToolCall(
  call: Pick<DynamicToolCallParams, "namespace" | "tool">,
): call is DynamicToolCallParams & {
  namespace: typeof TASK_MONITOR_TOOL_NAMESPACE;
  tool: TaskMonitorOperationName;
} {
  return (
    call.namespace === TASK_MONITOR_TOOL_NAMESPACE &&
    isTaskMonitorOperationName(call.tool)
  );
}

export async function handleTaskMonitorDynamicToolCall(params: {
  backend: AppServerBackendKind;
  call: DynamicToolCallParams;
  handler: TaskMonitorHandler;
}): Promise<DynamicToolCallResponse> {
  if (!isTaskMonitorDynamicToolCall(params.call)) {
    return buildTaskMonitorDynamicToolErrorResponse({
      code: "unsupported_operation",
      message: "Unsupported PwrAgent task monitor tool.",
    });
  }

  const context: TaskMonitorContext = {
    backend: params.backend,
    threadId: params.call.threadId,
    turnId: params.call.turnId,
  };
  const response = await params.handler({
    operation: params.call.tool,
    context,
    args: normalizeTaskMonitorToolArguments(
      params.call.tool,
      params.call.arguments,
    ),
  } as TaskMonitorRequest);
  return toDynamicToolResponse(response);
}

export function buildTaskMonitorDynamicToolErrorResponse(params: {
  code: "forbidden" | "internal_error" | "invalid_arguments" | "not_found" | "unsupported_operation";
  message: string;
  operation?: TaskMonitorOperationName;
}): DynamicToolCallResponse {
  return toDynamicToolResponse({
    ok: false,
    operation: params.operation ?? "create_monitor_delegation",
    error: {
      code: params.code,
      message: params.message,
    },
  });
}

export function buildMonitorDelegationPrompt(params: {
  finalHandoffPrompt?: string;
  monitorContext?: string;
  monitorId: string;
  parentThreadId: string;
  pollIntervalSeconds?: number;
  preferredModel?: string;
  preferredReasoningEffort?: string;
  task: string;
}): string {
  const pollInterval =
    normalizePollIntervalSeconds(params.pollIntervalSeconds) ??
    DEFAULT_TASK_MONITOR_POLL_INTERVAL_SECONDS;
  const preferredModel = normalizePreferredMonitorModel(params.preferredModel);
  const preferredReasoningEffort = normalizePreferredMonitorReasoningEffort(
    params.preferredReasoningEffort,
  );
  return [
    "You are a lightweight PwrAgent monitor subagent.",
    "",
    "Monitor only the asynchronous task below. Keep your context small and do not perform unrelated work.",
    "Typical monitor tasks include GitHub Actions, CI/CD, PR checks, deployments, builds, lint, and test jobs.",
    `Monitor id: ${params.monitorId}`,
    `Parent thread id: ${params.parentThreadId}`,
    `Poll interval: ${pollInterval} seconds`,
    `Preferred monitor model: ${preferredModel}`,
    `Preferred reasoning effort: ${preferredReasoningEffort}`,
    "",
    "Model guidance:",
    "- The parent agent should spawn this monitor on a cheap mini/non-thinking model when available.",
    "- For Codex, prefer the returned preferredModel and preferredReasoningEffort values.",
    "- For ACP or other agent runtimes, choose a non-thinking model or the lowest reasoning setting that can poll status reliably.",
    "",
    "Task:",
    params.task.trim(),
    params.monitorContext?.trim()
      ? ["", "Minimal context:", params.monitorContext.trim()].join("\n")
      : "",
    "",
    "Progress protocol:",
    `- Poll about every ${pollInterval} seconds while the task is incomplete.`,
    "- When the externally visible state changes, call pwragent_task_monitors.inject_progress with monitorId and a concise user-facing message.",
    "- Progress injections are non-waking: they must not ask the parent agent to act.",
    "- Do not include the parent transcript or broad repository context in progress updates.",
    "- When the task reaches success, failure, or cancellation, call pwragent_task_monitors.complete_monitoring exactly once.",
    "- The completion call is the only handoff that should trigger the parent agent.",
    params.finalHandoffPrompt?.trim()
      ? ["", "Final handoff guidance:", params.finalHandoffPrompt.trim()].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function normalizePollIntervalSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(5, Math.floor(value));
}

export function normalizePreferredMonitorModel(value: unknown): string {
  return readString(value) ?? DEFAULT_TASK_MONITOR_MODEL;
}

export function normalizePreferredMonitorReasoningEffort(value: unknown): string {
  return readString(value) ?? DEFAULT_TASK_MONITOR_REASONING_EFFORT;
}

function normalizeTaskMonitorToolArguments(
  operation: TaskMonitorOperationName,
  value: unknown,
): TaskMonitorRequest["args"] {
  const args = isRecord(value) ? value : {};
  if (operation === "create_monitor_delegation") {
    return {
      task: readString(args.task) ?? "",
      monitorContext: readString(args.monitorContext),
      pollIntervalSeconds: normalizePollIntervalSeconds(args.pollIntervalSeconds),
      preferredModel: readString(args.preferredModel),
      preferredReasoningEffort: readString(args.preferredReasoningEffort),
      finalHandoffPrompt: readString(args.finalHandoffPrompt),
    } satisfies CreateMonitorDelegationToolArgs;
  }
  if (operation === "inject_progress") {
    return {
      monitorId: readString(args.monitorId) ?? "",
      message: readString(args.message) ?? "",
      status: readMonitorProgressStatus(args.status),
    } satisfies InjectMonitorProgressToolArgs;
  }
  return {
    monitorId: readString(args.monitorId) ?? "",
    outcome: readMonitorOutcome(args.outcome) ?? "failure",
    summary: readString(args.summary) ?? "",
    details: readString(args.details),
    triggerParentTurn:
      typeof args.triggerParentTurn === "boolean" ? args.triggerParentTurn : undefined,
  } satisfies CompleteMonitoringToolArgs;
}

function toDynamicToolResponse(response: TaskMonitorResponse): DynamicToolCallResponse {
  return {
    success: response.ok,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify(response.ok ? response.data : response.error, null, 2),
      },
    ],
  };
}

function readMonitorProgressStatus(
  value: unknown,
): InjectMonitorProgressToolArgs["status"] {
  return value === "pending" ||
    value === "running" ||
    value === "blocked" ||
    value === "failed"
    ? value
    : undefined;
}

function readMonitorOutcome(value: unknown): CompleteMonitoringToolArgs["outcome"] | undefined {
  return value === "success" || value === "failure" || value === "cancelled"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
