import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CodexEnvironmentOption } from "@pwragent/shared";

type RawAction = {
  name?: string;
  icon?: string;
  command?: string;
};

type RawEnvironmentConfig = {
  name?: string;
  setup?: {
    script?: string;
  };
  cleanup?: {
    script?: string;
  };
  actions: RawAction[];
};

type ParserContext = "" | "setup" | "cleanup" | "action";

const KEY_LINE = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/;
const SECTION_LINE = /^\s*\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?$/;
const ARRAY_SECTION_LINE = /^\s*\[\[\s*([^\[\]]+?)\s*\]\]\s*(?:#.*)?$/;

export async function listCodexEnvironmentOptions(
  directoryPath?: string,
): Promise<CodexEnvironmentOption[]> {
  if (!directoryPath?.trim()) {
    return [];
  }

  const environmentsDir = path.join(
    directoryPath.trim(),
    ".codex",
    "environments",
  );
  let entries: string[];
  try {
    const directoryStat = await stat(environmentsDir);
    if (!directoryStat.isDirectory()) {
      return [];
    }
    entries = await readdir(environmentsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const options: CodexEnvironmentOption[] = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (!entry.endsWith(".toml")) {
      continue;
    }

    const sourcePath = path.join(environmentsDir, entry);
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) {
      continue;
    }

    const source = await readFile(sourcePath, "utf8");
    const parsed = parseCodexEnvironmentToml(source, sourcePath);
    const fallbackId = path.basename(entry, ".toml");
    const fallbackName = titleizeEnvironmentId(fallbackId);
    options.push({
      id: makeUniqueEnvironmentId(fallbackId, options),
      name: parsed.name?.trim() || fallbackName,
      sourcePath,
      setupScript: normalizeScript(parsed.setup?.script),
      cleanupScript: normalizeScript(parsed.cleanup?.script),
      actions: normalizeActions(parsed.actions),
    });
  }

  return options;
}

export function parseCodexEnvironmentToml(
  source: string,
  filePath = "<inline>",
): RawEnvironmentConfig {
  const config: RawEnvironmentConfig = { actions: [] };
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  let context: ParserContext = "";
  let currentAction: RawAction | undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = stripComment(line).trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    const arraySection = ARRAY_SECTION_LINE.exec(line);
    if (arraySection) {
      const name = arraySection[1]?.trim();
      if (name !== "actions") {
        context = "";
        currentAction = undefined;
      } else {
        currentAction = {};
        config.actions.push(currentAction);
        context = "action";
      }
      i += 1;
      continue;
    }

    const section = SECTION_LINE.exec(line);
    if (section) {
      const name = section[1]?.trim();
      context = name === "setup" || name === "cleanup" ? name : "";
      currentAction = undefined;
      i += 1;
      continue;
    }

    const keyMatch = KEY_LINE.exec(line);
    if (!keyMatch) {
      throw new Error(`Invalid Codex environment TOML line ${i + 1} in ${filePath}`);
    }

    const key = keyMatch[1]!;
    const valueStart = keyMatch[2]!;
    const parsed = parseTomlScalar(lines, i, valueStart, filePath);
    assignValue(config, context, currentAction, key, parsed.value);
    i = parsed.nextLine;
  }

  return config;
}

function assignValue(
  config: RawEnvironmentConfig,
  context: ParserContext,
  currentAction: RawAction | undefined,
  key: string,
  value: string | number | boolean,
): void {
  if (typeof value !== "string") {
    return;
  }

  if (context === "setup") {
    if (key === "script") {
      config.setup = { script: value };
    }
    return;
  }

  if (context === "cleanup") {
    if (key === "script") {
      config.cleanup = { script: value };
    }
    return;
  }

  if (context === "action" && currentAction) {
    if (key === "name" || key === "icon" || key === "command") {
      currentAction[key] = value;
    }
    return;
  }

  if (key === "name") {
    config.name = value;
  }
}

function parseTomlScalar(
  lines: string[],
  startLine: number,
  rawValue: string,
  filePath: string,
): { value: string | number | boolean; nextLine: number } {
  const value = rawValue.trimStart();
  if (value.startsWith("'''") || value.startsWith('"""')) {
    return parseMultilineString(lines, startLine, value, filePath);
  }

  const stripped = stripComment(value).trim();
  if (stripped.startsWith('"')) {
    return { value: JSON.parse(stripped), nextLine: startLine + 1 };
  }
  if (stripped.startsWith("'") && stripped.endsWith("'")) {
    return { value: stripped.slice(1, -1), nextLine: startLine + 1 };
  }
  if (stripped === "true" || stripped === "false") {
    return { value: stripped === "true", nextLine: startLine + 1 };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(stripped)) {
    return { value: Number(stripped), nextLine: startLine + 1 };
  }

  throw new Error(
    `Unsupported Codex environment TOML value on line ${startLine + 1} in ${filePath}`,
  );
}

function parseMultilineString(
  lines: string[],
  startLine: number,
  rawValue: string,
  filePath: string,
): { value: string; nextLine: number } {
  const delimiter = rawValue.startsWith("'''") ? "'''" : '"""';
  let remainder = rawValue.slice(3);
  const sameLineEnd = remainder.indexOf(delimiter);
  if (sameLineEnd >= 0) {
    return {
      value: decodeTomlString(remainder.slice(0, sameLineEnd), delimiter),
      nextLine: startLine + 1,
    };
  }

  const parts = [remainder];
  for (let i = startLine + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const end = line.indexOf(delimiter);
    if (end >= 0) {
      parts.push(line.slice(0, end));
      const raw = parts.join("\n").replace(/^\n/, "");
      return {
        value: decodeTomlString(raw, delimiter),
        nextLine: i + 1,
      };
    }
    parts.push(line);
  }

  throw new Error(
    `Unterminated Codex environment TOML multiline string on line ${startLine + 1} in ${filePath}`,
  );
}

function decodeTomlString(value: string, delimiter: "'''" | '"""'): string {
  if (delimiter === "'''") {
    return value;
  }
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function normalizeScript(script?: string): string | undefined {
  const normalized = script?.trim();
  return normalized || undefined;
}

function normalizeAction(
  action: RawAction,
  index: number,
  existingIds: Set<string>,
): CodexEnvironmentOption["actions"][number] | undefined {
  const command = action.command?.trim();
  if (!command) {
    return undefined;
  }

  const name = action.name?.trim() || `Action ${index + 1}`;
  const fallbackId = `action-${index + 1}`;
  const id = makeUniqueActionId(slugify(name) || fallbackId, existingIds);
  return {
    id,
    name,
    icon: action.icon?.trim() || undefined,
    command,
  };
}

function normalizeActions(
  actions: RawAction[],
): CodexEnvironmentOption["actions"] {
  const existingIds = new Set<string>();
  const normalized: CodexEnvironmentOption["actions"] = [];
  actions.forEach((action, index) => {
    const next = normalizeAction(action, index, existingIds);
    if (next) {
      normalized.push(next);
    }
  });
  return normalized;
}

function makeUniqueActionId(id: string, existingIds: Set<string>): string {
  let candidate = id;
  let counter = 2;
  while (existingIds.has(candidate)) {
    candidate = `${id}-${counter}`;
    counter += 1;
  }
  existingIds.add(candidate);
  return candidate;
}

function makeUniqueEnvironmentId(
  id: string,
  existing: CodexEnvironmentOption[],
): string {
  let candidate = slugify(id) || "environment";
  let counter = 2;
  while (existing.some((environment) => environment.id === candidate)) {
    candidate = `${slugify(id) || "environment"}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function titleizeEnvironmentId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Environment";
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripComment(value: string): string {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === "'" || char === '"') && value[i - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (char === "#" && !quote) {
      return value.slice(0, i);
    }
  }
  return value;
}
