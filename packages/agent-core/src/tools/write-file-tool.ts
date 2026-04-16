import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolExecutionContext } from "./tool-contract.js";
import {
  asObjectArguments,
  readRequiredString,
  requestToolApproval,
} from "./tool-contract.js";
import { InvalidToolArgumentsError, ToolExecutionFailure } from "./tool-errors.js";
import { resolveWorkspaceFilePath } from "./workspace-paths.js";

const TOOL_NAME = "write_file";

type WriteFileArguments = {
  path: string;
  content: string;
};

export function createWriteFileTool(): ToolDefinition<WriteFileArguments> {
  return {
    name: TOOL_NAME,
    description:
      "Create a new file or replace an existing file with the provided content.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file, relative to the current workspace.",
        },
        content: {
          type: "string",
          description: "Complete file contents to write.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    parseArguments(arguments_) {
      const record = asObjectArguments(TOOL_NAME, arguments_);
      const content = record.content;
      if (typeof content !== "string") {
        throw new InvalidToolArgumentsError(TOOL_NAME, '"content" must be a string');
      }
      return {
        path: readRequiredString(record, TOOL_NAME, "path"),
        content,
      };
    },
    async execute(arguments_, context) {
      const resolved = resolveWorkspaceFilePath(context, TOOL_NAME, arguments_.path);
      const approval = await maybeApproveFileChange(context, resolved.relativePath);
      if (approval) {
        return approval;
      }
      let existed = true;
      try {
        await fs.access(resolved.absolutePath);
      } catch {
        existed = false;
      }
      await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
      await fs.writeFile(resolved.absolutePath, arguments_.content, "utf8");
      return {
        success: true,
        output: `${existed ? "Updated" : "Created"} ${resolved.relativePath}.`,
        data: {
          path: resolved.relativePath,
          created: !existed,
          bytes: Buffer.byteLength(arguments_.content, "utf8"),
        },
      };
    },
  };
}

async function maybeApproveFileChange(
  context: ToolExecutionContext,
  relativePath: string,
) {
  if (context.approvalPolicy === "never") {
    return undefined;
  }
  const decision = await requestToolApproval(context, {
    requestId: `${TOOL_NAME}-${Math.random().toString(36).slice(2, 10)}`,
    kind: "fileChange",
    reason: "write_file modifies workspace files",
    path: relativePath,
  });
  if (decision === "approve") {
    return undefined;
  }
  return {
    success: false,
    output:
      decision === "cancel"
        ? `Approval cancelled for write_file: ${relativePath}`
        : `Approval declined for write_file: ${relativePath}`,
  };
}
