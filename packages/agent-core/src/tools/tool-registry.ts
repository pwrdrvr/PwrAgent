import type { ToolDefinition, ToolDescriptor } from "./tool-contract.js";
import { createListFilesTool } from "./list-files-tool.js";
import { createEditFileTool } from "./edit-file-tool.js";
import { createReadFileTool } from "./read-file-tool.js";
import { createSearchCodeTool } from "./search-code-tool.js";
import { createShellCommandTool } from "./shell-command-tool.js";
import { createWriteFileTool } from "./write-file-tool.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any>>();

  constructor(toolDefinitions: Array<ToolDefinition<any>> = []) {
    for (const tool of toolDefinitions) {
      this.register(tool);
    }
  }

  register(tool: ToolDefinition<any>): void {
    this.tools.set(tool.name, tool);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      readOnly: tool.readOnly,
    }));
  }

  get(name: string): ToolDefinition<any> | undefined {
    return this.tools.get(name);
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry([
    createReadFileTool(),
    createListFilesTool(),
    createSearchCodeTool(),
    createWriteFileTool(),
    createEditFileTool(),
    createShellCommandTool(),
  ]);
}
