import type { AppServerCommandAction } from "../app-server/protocol.js";

export type ShellSafetyClassification = {
  safe: boolean;
  commandAction: AppServerCommandAction;
  reason?: string;
};

const SHELL_METACHARACTER_PATTERN = /&&|\|\||[|;<>`]|[$][(]/;
const UNSAFE_RIPGREP_WITH_VALUE = [/^--pre(?:=|$)/, /^--hostname-bin(?:=|$)/];
const UNSAFE_RIPGREP_FLAGS = new Set(["--search-zip", "-z"]);
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "grep",
  "ls-files",
]);

export function classifyShellCommand(command: string): ShellSafetyClassification {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      safe: false,
      commandAction: "unknown",
      reason: "shell command cannot be empty",
    };
  }
  if (SHELL_METACHARACTER_PATTERN.test(trimmed)) {
    return {
      safe: false,
      commandAction: "unknown",
      reason: "shell metacharacters require approval",
    };
  }
  const tokens = splitShellWords(trimmed);
  if (tokens.length === 0) {
    return {
      safe: false,
      commandAction: "unknown",
      reason: "shell command cannot be empty",
    };
  }
  const [program, ...args] = tokens;
  if (program === "rg") {
    for (const arg of args) {
      if (
        UNSAFE_RIPGREP_FLAGS.has(arg) ||
        UNSAFE_RIPGREP_WITH_VALUE.some((pattern) => pattern.test(arg))
      ) {
        return {
          safe: false,
          commandAction: "search",
          reason: `ripgrep flag requires approval: ${arg}`,
        };
      }
    }
    return {
      safe: true,
      commandAction: "search",
    };
  }
  if (program === "git") {
    const subcommand = args[0];
    if (subcommand && SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
      return {
        safe: true,
        commandAction: subcommand === "grep" ? "search" : subcommand === "ls-files" ? "listFiles" : "unknown",
      };
    }
    return {
      safe: false,
      commandAction: "unknown",
      reason: "mutating or unknown git commands require approval",
    };
  }
  if (program === "cat" || program === "head" || program === "tail") {
    return { safe: true, commandAction: "read" };
  }
  if (program === "ls" || program === "find") {
    return { safe: true, commandAction: "listFiles" };
  }
  if (program === "pwd") {
    return { safe: true, commandAction: "unknown" };
  }
  return {
    safe: false,
    commandAction: "unknown",
    reason: `command requires approval: ${program}`,
  };
}

export function splitShellWords(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        current += command[index + 1] ?? "";
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      current += command[index + 1] ?? "";
      index += 1;
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}
