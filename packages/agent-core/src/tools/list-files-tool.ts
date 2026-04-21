import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolExecutionContext } from "./tool-contract.js";
import {
  asObjectArguments,
  readOptionalPositiveInteger,
  readOptionalString,
} from "./tool-contract.js";
import { runProcess, type ProcessRunResult } from "./process-runner.js";
import { ToolExecutionFailure } from "./tool-errors.js";
import { resolveWorkspaceScopePath, toPosix } from "./workspace-paths.js";

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
      const root = resolveWorkspaceScopePath(context, TOOL_NAME, arguments_.path);
      const limit = Math.min(arguments_.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const listResult = await listWorkspaceFiles(
        root.workspacePath,
        root.scopePath,
        limit,
        context,
      );
      if (listResult.files.length === 0) {
        return {
          success: true,
          output: `No files found in ${root.displayPath}.`,
          data: {
            path: root.scopeLabel,
            files: listResult.files,
            truncated: false,
          },
          commandAction: "listFiles",
        };
      }
      return {
        success: true,
        output: listResult.files.join("\n"),
        data: {
          path: root.scopeLabel,
          files: listResult.files,
          truncated: listResult.truncated,
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
  context: ToolExecutionContext,
): Promise<{ files: string[]; truncated: boolean }> {
  const ripgrepResult = await listWorkspaceFilesWithRipgrep(
    workspacePath,
    scopePath,
    limit,
    context,
  );
  if (ripgrepResult !== "missing") {
    return ripgrepResult;
  }

  const results: string[] = [];
  await walk(scopePath, async (entryPath) => {
    const relative = toPosix(path.relative(workspacePath, entryPath));
    results.push(relative);
    return results.length < limit;
  });
  return {
    files: results,
    truncated: results.length >= limit,
  };
}

async function listWorkspaceFilesWithRipgrep(
  workspacePath: string,
  scopePath: string,
  limit: number,
  context: ToolExecutionContext,
): Promise<{ files: string[]; truncated: boolean } | "missing"> {
  const prefix = path.relative(workspacePath, scopePath);
  const files: string[] = [];
  let pending = "";
  const result = await runProcess({
    command: "rg",
    args: ["--files", "."],
    cwd: scopePath,
    signal: context.signal,
    onStdoutChunk: (chunk, control) => {
      pending = collectFileLines({
        prefix,
        input: pending + chunk.toString("utf8"),
        files,
        limit,
        final: false,
      });
      if (files.length >= limit) {
        control.stop();
      }
    },
  });
  if (pending && files.length < limit) {
    collectFileLines({
      prefix,
      input: pending,
      files,
      limit,
      final: true,
    });
  }
  if (result.status === "failed_to_start" && isCommandMissing(result)) {
    return "missing";
  }
  if (result.status !== "completed" && result.status !== "stopped") {
    throw new ToolExecutionFailure(
      TOOL_NAME,
      processFailureMessage("ripgrep listing failed", result),
      "list_files_failed",
    );
  }
  if (result.exitCode && result.exitCode !== 0) {
    throw new ToolExecutionFailure(
      TOOL_NAME,
      processFailureMessage("ripgrep listing failed", result),
      "list_files_failed",
    );
  }
  return {
    files: files.sort((left, right) => left.localeCompare(right)),
    truncated: result.status === "stopped" || files.length >= limit,
  };
}

function collectFileLines(params: {
  prefix: string;
  input: string;
  files: string[];
  limit: number;
  final: boolean;
}): string {
  const lines = params.input.split(/\r?\n/);
  const completeLines = params.final ? lines : lines.slice(0, -1);
  for (const line of completeLines) {
    if (params.files.length >= params.limit || !line.trim()) {
      continue;
    }
    params.files.push(
      params.prefix
        ? path.posix.join(toPosix(params.prefix), toPosix(line.trim()))
        : toPosix(line.trim()),
    );
  }
  return params.final ? "" : (lines.at(-1) ?? "");
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

function isCommandMissing(result: ProcessRunResult): boolean {
  const error = result.error;
  return Boolean(
    error &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}

function processFailureMessage(prefix: string, result: ProcessRunResult): string {
  return [
    prefix,
    result.output || result.error?.message,
    `status=${result.status}`,
    `exitCode=${result.exitCode ?? "null"}`,
  ]
    .filter(Boolean)
    .join(": ");
}
