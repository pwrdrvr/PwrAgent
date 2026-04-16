import fs from "node:fs/promises";
import type { ToolDefinition, ToolExecutionContext } from "./tool-contract.js";
import {
  asObjectArguments,
  readRequiredString,
  requestToolApproval,
} from "./tool-contract.js";
import { InvalidToolArgumentsError, ToolExecutionFailure } from "./tool-errors.js";
import { resolveWorkspaceFilePath } from "./workspace-paths.js";

const TOOL_NAME = "edit_file";

type EditFileArguments = {
  path: string;
  oldString: string;
  newString: string;
};

export function createEditFileTool(): ToolDefinition<EditFileArguments> {
  return {
    name: TOOL_NAME,
    description:
      "Replace a unique string in a file with new content. The old string must appear exactly once.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file, relative to the current workspace.",
        },
        oldString: {
          type: "string",
          description: "Existing unique string to replace.",
        },
        newString: {
          type: "string",
          description: "Replacement string.",
        },
      },
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    },
    parseArguments(arguments_) {
      const record = asObjectArguments(TOOL_NAME, arguments_);
      const newString = record.newString;
      if (typeof newString !== "string") {
        throw new InvalidToolArgumentsError(TOOL_NAME, '"newString" must be a string');
      }
      return {
        path: readRequiredString(record, TOOL_NAME, "path"),
        oldString: readRequiredString(record, TOOL_NAME, "oldString"),
        newString,
      };
    },
    async execute(arguments_, context) {
      const resolved = resolveWorkspaceFilePath(context, TOOL_NAME, arguments_.path);
      let content: string;
      try {
        content = await fs.readFile(resolved.absolutePath, "utf8");
      } catch (error) {
        throw new ToolExecutionFailure(
          TOOL_NAME,
          `unable to read ${resolved.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
          "file_read_failed",
        );
      }

      const occurrences = content.split(arguments_.oldString).length - 1;
      if (occurrences === 0) {
        throw new ToolExecutionFailure(
          TOOL_NAME,
          `oldString not found in ${resolved.relativePath}`,
          "edit_anchor_missing",
        );
      }
      if (occurrences > 1) {
        throw new ToolExecutionFailure(
          TOOL_NAME,
          `oldString is not unique in ${resolved.relativePath} (${occurrences} occurrences)`,
          "edit_anchor_not_unique",
        );
      }

      const approval = await maybeApproveFileChange(context, resolved.relativePath);
      if (approval) {
        return approval;
      }

      const next = content.replace(arguments_.oldString, arguments_.newString);
      await fs.writeFile(resolved.absolutePath, next, "utf8");
      return {
        success: true,
        output: `Edited ${resolved.relativePath}.`,
        data: {
          path: resolved.relativePath,
          replacements: 1,
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
    reason: "edit_file modifies workspace files",
    path: relativePath,
  });
  if (decision === "approve") {
    return undefined;
  }
  return {
    success: false,
    output:
      decision === "cancel"
        ? `Approval cancelled for edit_file: ${relativePath}`
        : `Approval declined for edit_file: ${relativePath}`,
  };
}
