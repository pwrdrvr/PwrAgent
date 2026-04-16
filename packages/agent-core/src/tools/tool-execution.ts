import type { ToolExecutionContext, ToolExecutor, ToolInvocation } from "./tool-contract.js";
import { InvalidToolArgumentsError, ToolError, UnknownToolError } from "./tool-errors.js";
import { ToolRegistry } from "./tool-registry.js";

export class LocalToolExecutor implements ToolExecutor {
  private readonly registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  listTools() {
    return this.registry.list();
  }

  getTool(name: string) {
    return this.registry.get(name);
  }

  async executeTool(invocation: ToolInvocation, context: ToolExecutionContext) {
    const tool = this.registry.get(invocation.name);
    if (!tool) {
      return failureResult(
        invocation.name,
        invocation.arguments,
        new UnknownToolError(invocation.name),
      );
    }

    try {
      const parsedArguments = tool.parseArguments(invocation.arguments ?? {});
      const execution = await tool.execute(parsedArguments, context);
      return {
        toolName: tool.name,
        arguments: parsedArguments,
        success: execution.success,
        output: execution.output,
        data: execution.data,
        commandAction: execution.commandAction,
        item: {
          type: execution.itemType ?? "dynamicToolCall",
          text: execution.output,
          toolName: tool.name,
          success: execution.success,
          arguments: parsedArguments,
          commandAction: execution.commandAction,
          command: execution.command,
        },
      };
    } catch (error) {
      return failureResult(tool.name, invocation.arguments, error);
    }
  }
}

function failureResult(
  toolName: string,
  arguments_: Record<string, unknown> | undefined,
  error: unknown,
) {
  const normalized =
    error instanceof ToolError
      ? error
      : new ToolError(
          "execution_failed",
          `${toolName} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
  const output =
    error instanceof InvalidToolArgumentsError || error instanceof UnknownToolError
      ? normalized.message
      : normalized.message;
  return {
    toolName,
    arguments: (arguments_ ?? {}) as Record<string, unknown>,
    success: false,
    output,
    errorCode: normalized.code,
    item: {
      type: "dynamicToolCall" as const,
      text: output,
      toolName,
      success: false,
      arguments: (arguments_ ?? {}) as Record<string, unknown>,
    },
  };
}
