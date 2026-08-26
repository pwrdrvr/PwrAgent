import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";

export const BUNDLED_TOOLS_RESOURCE_DIRECTORY = "tools";
export const DEVELOPMENT_RIPGREP_DIRECTORY = [
  "build",
  "bundled-tools",
  "ripgrep",
] as const;

type BundledToolsOptions = {
  directory?: string;
  developmentMode?: boolean;
  developmentRoot?: string;
  platform?: NodeJS.Platform;
  resourcesPath?: string;
};

export function prependBundledToolsToPath(
  env: NodeJS.ProcessEnv,
  options: BundledToolsOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const toolDirectory = resolveBundledToolsDirectory(options);
  if (!toolDirectory) {
    return env;
  }

  const pathKey = resolvePathEnvKey(env, platform);
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const currentEntries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  const normalizedToolDirectory = normalizePathEntry(toolDirectory, platform);
  const nextEntries = [
    toolDirectory,
    ...currentEntries.filter(
      (entry) => normalizePathEntry(entry, platform) !== normalizedToolDirectory,
    ),
  ];
  if (
    nextEntries.length === currentEntries.length
    && nextEntries.every((entry, index) => entry === currentEntries[index])
  ) {
    return env;
  }
  return {
    ...env,
    [pathKey]: nextEntries.join(delimiter),
  };
}

export function resolveBundledToolsDirectory(
  options: BundledToolsOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const developmentRoot = options.developmentRoot ?? process.cwd();
  const developmentMode = options.developmentMode ?? process.defaultApp === true;
  const candidates = options.directory
    ? [options.directory]
    : [
        resourcesPath
          ? path.resolve(resourcesPath, BUNDLED_TOOLS_RESOURCE_DIRECTORY)
          : undefined,
        ...(developmentMode
          ? [
              path.resolve(developmentRoot, ...DEVELOPMENT_RIPGREP_DIRECTORY),
              path.resolve(
                developmentRoot,
                "apps",
                "desktop",
                ...DEVELOPMENT_RIPGREP_DIRECTORY,
              ),
            ]
          : []),
      ];
  const executable = platform === "win32" ? "rg.exe" : "rg";
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(path.join(candidate, executable), platform)) {
      return candidate;
    }
  }
  return undefined;
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) {
      return false;
    }
    if (platform !== "win32") {
      accessSync(candidate, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function normalizePathEntry(entry: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? entry.toLowerCase() : entry;
}

function resolvePathEnvKey(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32") {
    return "PATH";
  }
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}
