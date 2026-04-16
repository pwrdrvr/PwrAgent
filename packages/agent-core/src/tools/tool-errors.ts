export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

export class UnknownToolError extends ToolError {
  constructor(name: string) {
    super("unknown_tool", `Unknown tool: ${name}`);
    this.name = "UnknownToolError";
  }
}

export class InvalidToolArgumentsError extends ToolError {
  constructor(toolName: string, message: string) {
    super("invalid_arguments", `Invalid arguments for ${toolName}: ${message}`);
    this.name = "InvalidToolArgumentsError";
  }
}

export class ToolExecutionFailure extends ToolError {
  constructor(toolName: string, message: string, code = "execution_failed") {
    super(code, `${toolName} failed: ${message}`);
    this.name = "ToolExecutionFailure";
  }
}
