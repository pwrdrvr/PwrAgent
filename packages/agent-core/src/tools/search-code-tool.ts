import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition, ToolExecutionContext } from "./tool-contract.js";
import {
  asObjectArguments,
  readOptionalBoolean,
  readOptionalPositiveInteger,
  readOptionalString,
  readRequiredString,
} from "./tool-contract.js";
import { InvalidToolArgumentsError, ToolExecutionFailure } from "./tool-errors.js";

const execFileAsync = promisify(execFile);
const TOOL_NAME = "search_code";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const BINARY_BYTES_TO_CHECK = 2048;

type SearchCodeArguments = {
  query: string;
  path?: string;
  limit?: number;
  caseSensitive?: boolean;
  fixedStrings?: boolean;
};

type SearchMatch = {
  path: string;
  line: number;
  text: string;
};

export function createSearchCodeTool(): ToolDefinition<SearchCodeArguments> {
  return {
    name: TOOL_NAME,
    description:
      "Search repository contents with ripgrep-first behavior. Returns file paths, line numbers, and matching text.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Pattern to search for in workspace files.",
        },
        path: {
          type: "string",
          description: "Optional directory path inside the workspace to scope the search.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of matches to return.",
        },
        caseSensitive: {
          type: "boolean",
          description: "When true, search case-sensitively.",
        },
        fixedStrings: {
          type: "boolean",
          description: "When true, treat the query as a literal string instead of a regular expression.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    parseArguments(arguments_) {
      const record = asObjectArguments(TOOL_NAME, arguments_);
      return {
        query: readRequiredString(record, TOOL_NAME, "query"),
        path: readOptionalString(record, TOOL_NAME, "path"),
        limit: readOptionalPositiveInteger(record, TOOL_NAME, "limit"),
        caseSensitive: readOptionalBoolean(record, TOOL_NAME, "caseSensitive"),
        fixedStrings: readOptionalBoolean(record, TOOL_NAME, "fixedStrings"),
      };
    },
    async execute(arguments_, context) {
      const root = resolveWorkspacePath(context, arguments_.path);
      const limit = Math.min(arguments_.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const matches = await searchWorkspace(root.workspacePath, root.scopePath, arguments_, limit);
      if (matches.length === 0) {
        return {
          success: true,
          output: `No matches found for "${arguments_.query}" in ${root.displayPath}.`,
          data: {
            query: arguments_.query,
            path: root.scopeLabel,
            matches: [],
          },
          commandAction: "search",
        };
      }
      return {
        success: true,
        output: matches
          .map((match) => `${match.path}:${match.line}: ${match.text}`)
          .join("\n"),
        data: {
          query: arguments_.query,
          path: root.scopeLabel,
          matches,
          truncated: matches.length >= limit,
        },
        commandAction: "search",
      };
    },
  };
}

async function searchWorkspace(
  workspacePath: string,
  scopePath: string,
  arguments_: SearchCodeArguments,
  limit: number,
): Promise<SearchMatch[]> {
  try {
    return await searchWithRipgrep(workspacePath, scopePath, arguments_, limit);
  } catch (error) {
    if (!isCommandMissing(error)) {
      if (isNoMatchesError(error)) {
        return [];
      }
      throw new ToolExecutionFailure(
        TOOL_NAME,
        `ripgrep search failed: ${error instanceof Error ? error.message : String(error)}`,
        "search_failed",
      );
    }
  }
  return await searchWithFallback(workspacePath, scopePath, arguments_, limit);
}

async function searchWithRipgrep(
  workspacePath: string,
  scopePath: string,
  arguments_: SearchCodeArguments,
  limit: number,
): Promise<SearchMatch[]> {
  const args = ["--line-number", "--no-heading", "--color", "never"];
  if (arguments_.fixedStrings) {
    args.push("--fixed-strings");
  }
  if (!arguments_.caseSensitive) {
    args.push("--ignore-case");
  }
  args.push(arguments_.query, ".");
  const { stdout } = await execFileAsync("rg", args, {
    cwd: scopePath,
    maxBuffer: 1024 * 1024,
  });
  const prefix = path.relative(workspacePath, scopePath);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseRipgrepLine(prefix, line))
    .slice(0, limit);
}

function parseRipgrepLine(prefix: string, line: string): SearchMatch {
  const firstColon = line.indexOf(":");
  const secondColon = line.indexOf(":", firstColon + 1);
  const rawPath = line.slice(0, firstColon);
  const rawLine = line.slice(firstColon + 1, secondColon);
  const rawText = line.slice(secondColon + 1).trim();
  return {
    path: normalizeRelativePath(
      prefix ? path.posix.join(toPosix(prefix), toPosix(rawPath)) : toPosix(rawPath),
    ),
    line: Number.parseInt(rawLine, 10),
    text: rawText,
  };
}

async function searchWithFallback(
  workspacePath: string,
  scopePath: string,
  arguments_: SearchCodeArguments,
  limit: number,
): Promise<SearchMatch[]> {
  const files = await collectFiles(scopePath, workspacePath, limit * 10);
  const matcher = buildMatcher(arguments_);
  const matches: SearchMatch[] = [];
  for (const file of files) {
    if (matches.length >= limit) {
      break;
    }
    const absolutePath = path.join(workspacePath, file);
    const buffer = await fs.readFile(absolutePath);
    if (buffer.subarray(0, BINARY_BYTES_TO_CHECK).includes(0)) {
      continue;
    }
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher(lines[index] ?? "")) {
        continue;
      }
      matches.push({
        path: toPosix(file),
        line: index + 1,
        text: (lines[index] ?? "").trim(),
      });
      if (matches.length >= limit) {
        break;
      }
    }
  }
  return matches;
}

function buildMatcher(arguments_: SearchCodeArguments) {
  if (arguments_.fixedStrings) {
    const query = arguments_.caseSensitive
      ? arguments_.query
      : arguments_.query.toLowerCase();
    return (line: string) =>
      (arguments_.caseSensitive ? line : line.toLowerCase()).includes(query);
  }
  const flags = arguments_.caseSensitive ? "" : "i";
  let expression: RegExp;
  try {
    expression = new RegExp(arguments_.query, flags);
  } catch (error) {
    throw new InvalidToolArgumentsError(
      TOOL_NAME,
      error instanceof Error ? error.message : String(error),
    );
  }
  return (line: string) => expression.test(line);
}

async function collectFiles(
  directory: string,
  workspacePath: string,
  limit: number,
): Promise<string[]> {
  const results: string[] = [];
  await walk(directory, async (entryPath) => {
    results.push(path.relative(workspacePath, entryPath));
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

function isNoMatchesError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 1,
  );
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function normalizeRelativePath(value: string): string {
  return value.startsWith("./") ? value.slice(2) : value;
}
