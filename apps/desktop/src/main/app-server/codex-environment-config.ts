import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  CodexEnvironmentOption,
  NavigationLaunchpadDraft,
} from "@pwragent/shared";
import { tokenizeCodexEnvironmentToml } from "./codex-environment-toml";

type RawAction = {
  name?: string;
  icon?: string;
  command?: string;
  platform?: string;
};

type EnvironmentPlatform = "darwin" | "linux" | "win32";
type ScriptConfig = { script?: string } & Partial<
  Record<EnvironmentPlatform, { script?: string }>
>;

type RawEnvironmentConfig = {
  name?: string;
  setup?: ScriptConfig;
  cleanup?: ScriptConfig;
  actions: RawAction[];
};

type ParserContext =
  | ""
  | "setup"
  | "cleanup"
  | "action"
  | `${"setup" | "cleanup"}.${EnvironmentPlatform}`;

export async function listCodexEnvironmentOptions(
  directoryPath?: string,
  platform: NodeJS.Platform = process.platform,
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
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
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
      setupScript: resolvePlatformScript(parsed.setup, platform),
      cleanupScript: resolvePlatformScript(parsed.cleanup, platform),
      ...(platform === "win32" ? { shell: "powershell" as const } : {}),
      actions: normalizeActions(parsed.actions, platform),
    });
  }

  return options;
}

export function withCodexEnvironmentOptions(
  launchpad: NavigationLaunchpadDraft,
  options: CodexEnvironmentOption[],
): NavigationLaunchpadDraft {
  const launchpadWithoutDeprecatedSetupFlag = { ...launchpad };
  delete launchpadWithoutDeprecatedSetupFlag.codexEnvironmentSetupEnabled;

  if (options.length === 0) {
    return {
      ...launchpadWithoutDeprecatedSetupFlag,
      codexEnvironmentId: undefined,
      codexEnvironmentActionId: undefined,
      codexEnvironmentOptions: [],
    };
  }

  const selectedEnvironment = options.find(
    (environment) => environment.id === launchpad.codexEnvironmentId,
  );
  const selectedAction = selectedEnvironment?.actions.find(
    (action) => action.id === launchpad.codexEnvironmentActionId,
  );
  return {
    ...launchpadWithoutDeprecatedSetupFlag,
    codexEnvironmentId: selectedEnvironment?.id,
    codexEnvironmentExecutionTarget:
      launchpad.codexEnvironmentExecutionTarget ?? "local",
    codexEnvironmentActionId: selectedAction?.id,
    codexEnvironmentOptions: options,
  };
}

export type CodexEnvironmentSelectorResolution =
  | { kind: "found"; environment: CodexEnvironmentOption }
  | { kind: "missing"; message: string };

/**
 * Resolve an agent's environment selector. An exact id wins, then an id or
 * a name compared without case. A name two environments share is refused,
 * because picking one would run the wrong setup.
 */
export function resolveCodexEnvironmentSelector(
  selector: string,
  options: CodexEnvironmentOption[],
  projectLabel = "this project",
): CodexEnvironmentSelectorResolution {
  const wanted = selector.trim();
  const exact = options.find((option) => option.id === wanted);
  if (exact) {
    return { kind: "found", environment: exact };
  }
  const folded = wanted.toLowerCase();
  const byId = options.find((option) => option.id.toLowerCase() === folded);
  if (byId) {
    return { kind: "found", environment: byId };
  }
  const byName = options.filter(
    (option) => option.name.trim().toLowerCase() === folded,
  );
  if (byName.length === 1) {
    return { kind: "found", environment: byName[0] };
  }
  if (byName.length > 1) {
    return {
      kind: "missing",
      message: `Environment "${wanted}" matches more than one environment: ${describeEnvironmentOptions(byName)}. Pass an id.`,
    };
  }
  const available = options.length > 0
    ? `Available environments: ${describeEnvironmentOptions(options)}.`
    : "The project has no .codex/environments/*.toml files.";
  return {
    kind: "missing",
    message: `Environment "${wanted}" is not defined in ${projectLabel}. ${available} Pass environment="none" to start without one.`,
  };
}

function describeEnvironmentOptions(options: CodexEnvironmentOption[]): string {
  return options.map((option) => `${option.name} (${option.id})`).join(", ");
}

export function pruneCodexEnvironmentActionMap(
  map: Record<string, string> | undefined,
  options: CodexEnvironmentOption[],
): Record<string, string> {
  if (!map) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(map).filter(([environmentId, actionId]) => {
      const environment = options.find((candidate) => candidate.id === environmentId);
      return Boolean(
        environment?.actions.some((action) => action.id === actionId),
      );
    }),
  );
}

export function resolveCodexEnvironmentActionId(params: {
  actionId?: string;
  environment: CodexEnvironmentOption;
  selectedActionIdByEnvironmentId: Record<string, string>;
}): string | undefined {
  if (params.environment.actions.some((action) => action.id === params.actionId)) {
    return params.actionId;
  }
  const mappedActionId =
    params.selectedActionIdByEnvironmentId[params.environment.id];
  if (params.environment.actions.some((action) => action.id === mappedActionId)) {
    return mappedActionId;
  }
  return params.environment.actions[0]?.id;
}

export async function hydrateLaunchpadCodexEnvironmentOptions(
  launchpad: NavigationLaunchpadDraft,
): Promise<NavigationLaunchpadDraft> {
  return withCodexEnvironmentOptions(
    launchpad,
    await listCodexEnvironmentOptions(launchpad.directoryPath),
  );
}

export function parseCodexEnvironmentToml(
  source: string,
  filePath = "<inline>",
): RawEnvironmentConfig {
  const config: RawEnvironmentConfig = { actions: [] };
  for (const block of tokenizeCodexEnvironmentToml(source, filePath).blocks) {
    let context: ParserContext = "";
    let currentAction: RawAction | undefined;
    if (block.header?.kind === "array") {
      if (block.header.name === "actions") {
        currentAction = {};
        config.actions.push(currentAction);
        context = "action";
      }
    } else if (block.header) {
      context = /^(setup|cleanup)(\.(darwin|linux|win32))?$/.test(block.header.name)
        ? block.header.name as ParserContext
        : "";
    }
    for (const entry of block.entries) {
      assignValue(config, context, currentAction, entry.key, entry.value);
    }
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

  if (context === "setup" || context === "cleanup" || context.includes(".")) {
    if (key === "script") {
      const [section, platform] = context.split(".") as [
        "setup" | "cleanup", EnvironmentPlatform | undefined,
      ];
      const scripts = config[section] ??= {};
      if (platform) {
        scripts[platform] = { script: value };
      } else {
        scripts.script = value;
      }
    }
    return;
  }

  if (context === "action" && currentAction) {
    if (key === "name" || key === "icon" || key === "command" || key === "platform") {
      currentAction[key] = value;
    }
    return;
  }

  if (key === "name") {
    config.name = value;
  }
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

function resolvePlatformScript(
  scripts: ScriptConfig | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const override = platform === "darwin" || platform === "linux" || platform === "win32"
    ? scripts?.[platform]?.script
    : undefined;
  return normalizeScript(override ?? scripts?.script);
}

function normalizeActions(
  actions: RawAction[],
  platform: NodeJS.Platform,
): CodexEnvironmentOption["actions"] {
  const existingIds = new Set<string>();
  const normalized: CodexEnvironmentOption["actions"] = [];
  const platformActions = actions.filter(
    (action) => !action.platform || action.platform === platform,
  );
  platformActions.forEach((action, index) => {
    const next = normalizeAction(action, index, existingIds);
    if (next) {
      normalized.push({
        ...next,
        ...(platform === "win32" ? { shell: "powershell" as const } : {}),
      });
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
