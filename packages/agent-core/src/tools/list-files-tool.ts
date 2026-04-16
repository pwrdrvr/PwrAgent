import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition, ToolExecutionContext } from "./tool-contract.js";
import {
  asObjectArguments,
  readOptionalPositiveInteger,
  readOptionalString,
} from "./tool-contract.js";
import { ToolExecutionFailure } from "./tool-errors.js";

const execFileAsync = promisify(execFile);
const TOOL_NAME = "list_files";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

type ListFilesArguments = {
  path?: string;
  limit?: number;
};

export function createListFilesTool(): ToolDefinition<ListFilesArguments> {
  return {
    name: TOOL_NAME,
    description:
      "List files in the current workspace. Uses ripgrep when available and falls back to a deterministic filesystem walk.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional directory path inside the workspace to scope the listing.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of paths to return.",
        },
      },
      additionalProperties: false,
    },
    parseArguments(arguments_) {
      const record = asObjectArguments(TOOL_NAME, arguments_);
      return {
        path: readOptionalString(record, TOOL_NAME, "path"),
        limit: readOptionalPositiveInteger(record, TOOL_NAME, "limit"),
      };
    },
    async execute(arguments_, context) {
      const root = resolveWorkspacePath(context, arguments_.path);
      const limit = Math.min(arguments_.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const files = await listWorkspaceFiles(root.workspacePath, root.scopePath, limit);
      if (files.length === 0) {
        return {
          success: true,
          output: `No files found in ${root.displayPath}.`,
          data: {
            path: root.scopeLabel,
            files: [],
            truncated: false,
          },
          commandAction: "listFiles",
        };
      }
      return {
        success: true,
        output: files.join("\n"),
        data: {
          path: root.scopeLabel,
          files,
          truncated: files.length >= limit,
        },
        commandAction: "listFiles",
      };
    },
  };
}

async function listWorkspaceFiles(
  workspacePath: string,
  scopePath: string,
  limit: number,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--files", "."],
      {
        cwd: scopePath,
        maxBuffer: 1024 * 1024,
      },
    );
    const prefix = path.relative(workspacePath, scopePath);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (prefix ? path.posix.join(toPosix(prefix), toPosix(line)) : toPosix(line)))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, limit);
  } catch (error) {
    if (!isCommandMissing(error)) {
      throw new ToolExecutionFailure(
        TOOL_NAME,
        `ripgrep listing failed: ${error instanceof Error ? error.message : String(error)}`,
        "list_files_failed",
      );
    }
  }

  const results: string[] = [];
  await walk(scopePath, async (entryPath) => {
    const relative = toPosix(path.relative(workspacePath, entryPath));
    results.push(relative);
    return results.length < limit;
  });
  return results;
}

async function walk(
  directory: string,
  onFile: (filePath: string) => Promise<boolean>,
): Promise<boolean> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const nextPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const shouldContinue = await walk(nextPath, onFile);
      if (!shouldContinue) {
        return false;
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const shouldContinue = await onFile(nextPath);
    if (!shouldContinue) {
      return false;
    }
  }
  return true;
}

function resolveWorkspacePath(context: ToolExecutionContext, scope: string | undefined) {
  const workspacePath = context.cwd?.trim();
  if (!workspacePath) {
    throw new ToolExecutionFailure(
      TOOL_NAME,
      "thread cwd is required for repository tools",
      "missing_cwd",
    );
  }
  const scopePath = path.resolve(workspacePath, scope ?? ".");
  const relative = path.relative(workspacePath, scopePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolExecutionFailure(
      TOOL_NAME,
      `path escapes workspace: ${scope ?? "."}`,
      "path_outside_workspace",
    );
  }
  return {
    workspacePath,
    scopePath,
    scopeLabel: relative ? toPosix(relative) : ".",
    displayPath: relative ? toPosix(relative) : "workspace",
  };
}

function isCommandMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
