import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolExecutionContext } from "./tool-contract.js";
import {
  asObjectArguments,
  readOptionalPositiveInteger,
  readRequiredString,
} from "./tool-contract.js";
import { ToolExecutionFailure, InvalidToolArgumentsError } from "./tool-errors.js";

const TOOL_NAME = "read_file";
const DEFAULT_MAX_LINES = 200;
const MAX_LINES = 500;

type ReadFileArguments = {
  path: string;
  startLine?: number;
  endLine?: number;
};

export function createReadFileTool(): ToolDefinition<ReadFileArguments> {
  return {
    name: TOOL_NAME,
    description:
      "Read a file from the current workspace. Returns numbered lines and supports optional line ranges.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file, relative to the current workspace.",
        },
        startLine: {
          type: "integer",
          description: "Optional first line to include, using 1-based numbering.",
        },
        endLine: {
          type: "integer",
          description: "Optional last line to include, using 1-based numbering.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    parseArguments(arguments_) {
      const record = asObjectArguments(TOOL_NAME, arguments_);
      const filePath = readRequiredString(record, TOOL_NAME, "path");
      const startLine = readOptionalPositiveInteger(record, TOOL_NAME, "startLine");
      const endLine = readOptionalPositiveInteger(record, TOOL_NAME, "endLine");
      if (startLine && endLine && endLine < startLine) {
        throw new InvalidToolArgumentsError(
          TOOL_NAME,
          `"endLine" must be greater than or equal to "startLine"`,
        );
      }
      return {
        path: filePath,
        startLine,
        endLine,
      };
    },
    async execute(arguments_, context) {
      const resolved = resolveWorkspacePath(context, arguments_.path);
      let content: string;
      try {
        content = await fs.readFile(resolved.absolutePath, "utf8");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        throw new ToolExecutionFailure(
          TOOL_NAME,
          `unable to read ${resolved.relativePath}: ${message}`,
          "file_read_failed",
        );
      }

      if (content.includes("\0")) {
        throw new ToolExecutionFailure(
          TOOL_NAME,
          `cannot read binary file: ${resolved.relativePath}`,
          "binary_file",
        );
      }

      const lines = content.split(/\r?\n/);
      const startLine = arguments_.startLine ?? 1;
      const requestedEndLine = arguments_.endLine ?? lines.length;
      const cappedEndLine = Math.min(
        requestedEndLine,
        startLine + MAX_LINES - 1,
      );
      const limitedByDefault =
        arguments_.startLine == null &&
        arguments_.endLine == null &&
        lines.length > DEFAULT_MAX_LINES;
      const endLine = limitedByDefault
        ? Math.min(DEFAULT_MAX_LINES, lines.length)
        : Math.min(cappedEndLine, lines.length);
      const visible = lines.slice(startLine - 1, endLine).map((line, index) => {
        const lineNumber = startLine + index;
        return `${lineNumber}: ${line}`;
      });
      return {
        success: true,
        output: `${resolved.relativePath}\n${visible.join("\n")}`.trim(),
        data: {
          path: resolved.relativePath,
          startLine,
          endLine,
          totalLines: lines.length,
          truncated: endLine < lines.length,
        },
        commandAction: "read",
      };
    },
  };
}

function resolveWorkspacePath(context: ToolExecutionContext, targetPath: string) {
  const cwd = context.cwd?.trim();
  if (!cwd) {
    throw new ToolExecutionFailure(
      TOOL_NAME,
      "thread cwd is required for repository tools",
      "missing_cwd",
    );
  }
  const absolutePath = path.resolve(cwd, targetPath);
  const relativePath = path.relative(cwd, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new ToolExecutionFailure(
      TOOL_NAME,
      `path escapes workspace: ${targetPath}`,
      "path_outside_workspace",
    );
  }
  return {
    absolutePath,
    relativePath: relativePath || path.basename(absolutePath),
  };
}
