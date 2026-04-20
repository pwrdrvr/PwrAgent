import type { AppServerCommandAction } from "../app-server/protocol.js";
import type { ProcessOutputDelta } from "./process-runner.js";
import { InvalidToolArgumentsError } from "./tool-errors.js";

export type ToolInputSchemaProperty = {
  type: "string" | "integer" | "number" | "boolean";
  description?: string;
};

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, ToolInputSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolExecutionContext = {
  cwd?: string;
  threadId?: string;
  approvalPolicy?: string;
  sandbox?: string;
  signal?: AbortSignal;
  onOutputDelta?: (delta: ProcessOutputDelta) => void;
  requestApproval?: (
    request: ToolApprovalRequest,
  ) => Promise<unknown> | unknown;
};

export type ToolInvocation = {
  name: string;
  arguments?: Record<string, unknown>;
};

export type ToolExecutionOutput = {
  success: boolean;
  output: string;
  data?: Record<string, unknown>;
  commandAction?: AppServerCommandAction;
  itemType?: "dynamicToolCall" | "commandExecution";
  command?: string;
};

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  readOnly: boolean;
};

export type ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>> =
  ToolDescriptor & {
    parseArguments: (arguments_: Record<string, unknown>) => TArgs;
    execute: (
      arguments_: TArgs,
      context: ToolExecutionContext,
    ) => Promise<ToolExecutionOutput>;
  };

export interface ToolExecutor {
  listTools(): ToolDescriptor[];
  getTool(name: string): ToolDescriptor | undefined;
  executeTool(
    invocation: ToolInvocation,
    context: ToolExecutionContext,
  ): Promise<{
    toolName: string;
    arguments: Record<string, unknown>;
    success: boolean;
    output: string;
    data?: Record<string, unknown>;
    errorCode?: string;
    commandAction?: AppServerCommandAction;
    item: {
      type: "dynamicToolCall" | "commandExecution";
      text: string;
      toolName: string;
      success: boolean;
      arguments: Record<string, unknown>;
      commandAction?: AppServerCommandAction;
      command?: string;
      data?: Record<string, unknown>;
    };
  }>;
}

export type ToolApprovalKind = "fileChange" | "commandExecution";

export type ToolApprovalDecision = "approve" | "decline" | "cancel";

export type ToolApprovalRequest = {
  requestId: string;
  kind: ToolApprovalKind;
  reason?: string;
  path?: string;
  command?: string;
  commandAction?: AppServerCommandAction;
};

export function asObjectArguments(
  toolName: string,
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidToolArgumentsError(toolName, "arguments must be an object");
  }
  return value as Record<string, unknown>;
}

export function readRequiredString(
  arguments_: Record<string, unknown>,
  toolName: string,
  key: string,
): string {
  const value = arguments_[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidToolArgumentsError(
      toolName,
      `"${key}" must be a non-empty string`,
    );
  }
  return value.trim();
}

export function readOptionalString(
  arguments_: Record<string, unknown>,
  toolName: string,
  key: string,
): string | undefined {
  const value = arguments_[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidToolArgumentsError(toolName, `"${key}" must be a string`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function readOptionalBoolean(
  arguments_: Record<string, unknown>,
  toolName: string,
  key: string,
): boolean | undefined {
  const value = arguments_[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new InvalidToolArgumentsError(toolName, `"${key}" must be a boolean`);
  }
  return value;
}

export function readOptionalPositiveInteger(
  arguments_: Record<string, unknown>,
  toolName: string,
  key: string,
): number | undefined {
  const value = arguments_[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidToolArgumentsError(
      toolName,
      `"${key}" must be a positive integer`,
    );
  }
  return value;
}

export function normalizeApprovalDecision(value: unknown): ToolApprovalDecision {
  if (
    value &&
    typeof value === "object" &&
    "decision" in value &&
    typeof (value as { decision?: unknown }).decision === "string"
  ) {
    return normalizeApprovalDecision((value as { decision: string }).decision);
  }
  if (value === "approve") {
    return "approve";
  }
  if (value === "cancel") {
    return "cancel";
  }
  return "decline";
}

export async function requestToolApproval(
  context: ToolExecutionContext,
  request: ToolApprovalRequest,
): Promise<ToolApprovalDecision> {
  if (!context.requestApproval) {
    return "decline";
  }
  const response = await context.requestApproval(request);
  return normalizeApprovalDecision(response);
}
