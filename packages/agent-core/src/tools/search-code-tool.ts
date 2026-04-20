import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolExecutionContext } from "./tool-contract.js";
import {
  asObjectArguments,
  readOptionalBoolean,
  readOptionalPositiveInteger,
  readOptionalString,
  readRequiredString,
} from "./tool-contract.js";
import { runProcess, type ProcessRunResult } from "./process-runner.js";
import { InvalidToolArgumentsError, ToolExecutionFailure } from "./tool-errors.js";
import { resolveWorkspaceScopePath, toPosix } from "./workspace-paths.js";

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
          description:
            "Optional file or directory path inside the workspace to scope the search.",
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
      const root = resolveWorkspaceScopePath(context, TOOL_NAME, arguments_.path);
      const limit = Math.min(arguments_.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const matches = await searchWorkspace(
        root.workspacePath,
        root.scopePath,
        arguments_,
        limit,
        context,
      );
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
  context: ToolExecutionContext,
): Promise<SearchMatch[]> {
  const scope = await describeSearchScope(workspacePath, scopePath);
  const result = await searchWithRipgrep(
    scope,
    arguments_,
    limit,
    context,
  );
  if (result === "missing") {
    return await searchWithFallback(workspacePath, scope, arguments_, limit);
  }
  return result;
}

type SearchScope = {
  scopePath: string;
  cwd: string;
  target: string;
  prefix: string;
  isFile: boolean;
};

async function describeSearchScope(
  workspacePath: string,
  scopePath: string,
): Promise<SearchScope> {
  const stats = await fs.stat(scopePath);
  if (stats.isFile()) {
    return {
      scopePath,
      cwd: workspacePath,
      target: toPosix(path.relative(workspacePath, scopePath)),
      prefix: "",
      isFile: true,
    };
  }
  return {
    scopePath,
    cwd: scopePath,
    target: ".",
    prefix: path.relative(workspacePath, scopePath),
    isFile: false,
  };
}

async function searchWithRipgrep(
  scope: SearchScope,
  arguments_: SearchCodeArguments,
  limit: number,
  context: ToolExecutionContext,
): Promise<SearchMatch[] | "missing"> {
  const args = [
    "--line-number",
    "--no-heading",
    "--with-filename",
    "--color",
    "never",
  ];
  if (arguments_.fixedStrings) {
    args.push("--fixed-strings");
  }
  if (!arguments_.caseSensitive) {
    args.push("--ignore-case");
  }
  args.push(arguments_.query, scope.target);
  const matches: SearchMatch[] = [];
  let pending = "";
  const result = await runProcess({
    command: "rg",
    args,
    cwd: scope.cwd,
    signal: context.signal,
    onStdoutChunk: (chunk, control) => {
      pending = collectRipgrepMatches({
        prefix: scope.prefix,
        input: pending + chunk.toString("utf8"),
        matches,
        limit,
        final: false,
      });
      if (matches.length >= limit) {
        control.stop();
      }
    },
  });
  if (pending && matches.length < limit) {
    collectRipgrepMatches({
      prefix: scope.prefix,
      input: pending,
      matches,
      limit,
      final: true,
    });
  }
  if (result.status === "failed_to_start" && isCommandMissing(result)) {
    return "missing";
  }
  if (result.exitCode === 1) {
    return matches;
  }
  if (result.status !== "completed" && result.status !== "stopped") {
    throw new ToolExecutionFailure(
      TOOL_NAME,
      processFailureMessage("ripgrep search failed", result),
      "search_failed",
    );
  }
  if (result.exitCode && result.exitCode !== 0) {
    throw new ToolExecutionFailure(
      TOOL_NAME,
      processFailureMessage("ripgrep search failed", result),
      "search_failed",
    );
  }
  return matches;
}

function collectRipgrepMatches(params: {
  prefix: string;
  input: string;
  matches: SearchMatch[];
  limit: number;
  final: boolean;
}): string {
  const lines = params.input.split(/\r?\n/);
  const completeLines = params.final ? lines : lines.slice(0, -1);
  for (const line of completeLines) {
    if (params.matches.length >= params.limit || !line.trim()) {
      continue;
    }
    params.matches.push(parseRipgrepLine(params.prefix, line.trim()));
  }
  return params.final ? "" : (lines.at(-1) ?? "");
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
  scope: SearchScope,
  arguments_: SearchCodeArguments,
  limit: number,
): Promise<SearchMatch[]> {
  const files = scope.isFile
    ? [path.relative(workspacePath, scope.scopePath)]
    : await collectFiles(scope.scopePath, workspacePath, limit * 10);
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

function normalizeRelativePath(value: string): string {
  return value.startsWith("./") ? value.slice(2) : value;
}
