import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AcpAgentSettingsEntry,
  AcpBackendId,
} from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env.js";
import { getAppStateMode } from "../state/app-state.js";
import {
  resolveActiveProfilePath,
  resolveBootstrapProfilePath,
} from "../profile.js";
import { buildCommandDiscoveryCandidate } from "../settings/command-discovery.js";
import { acpAgentCapabilitiesForRegistryId } from "./acp-agent-capabilities.js";
import type {
  AcpInstalledAgentRecord,
  AcpRegistryAgent,
} from "./acp-registry-types.js";

const execFile = promisify(execFileCallback);

export const CLAUDE_ACP_REGISTRY_ID = "claude-acp";
export const CLAUDE_ACP_BACKEND_ID = "acp:claude-acp" as AcpBackendId;
export const CLAUDE_ACP_NAME = "Claude Agent";
export const CLAUDE_ACP_PACKAGE_NAME =
  "@agentclientprotocol/claude-agent-acp";
export const CLAUDE_ACP_VERSION = "0.60.0";
export const CLAUDE_ACP_PACKAGE_SPEC =
  `${CLAUDE_ACP_PACKAGE_NAME}@${CLAUDE_ACP_VERSION}`;
export const CLAUDE_ACP_PACKAGE_INTEGRITY =
  "sha512-+ZZCJukpKdEY+/O982UCtgGHOY+MKa/JPpZ34v25ITawRyQyg3cqqOGo3M+9TsA4D+T/NXb+kT3zUB1uQZhY+Q==";
export const CLAUDE_ACP_ALLOWLIST_RULE_ID =
  "managed-claude-agent-acp-0.60.0";
export const CLAUDE_ACP_REPOSITORY_URL =
  "https://github.com/agentclientprotocol/claude-agent-acp";

const CLAUDE_ACP_RUNTIME_DIRECTORY =
  `state/acp-runtimes/claude-agent-acp/${CLAUDE_ACP_VERSION}`;
const CLAUDE_ACP_MARKER_FILE = "pwragent-runtime.json";
const CLAUDE_ACP_PACKAGE_LOCK_KEY =
  "node_modules/@agentclientprotocol/claude-agent-acp";
const CLAUDE_ACP_BIN_NAME = "claude-agent-acp";
const CLAUDE_ACP_MINIMUM_NODE_MAJOR = 22;
const CLAUDE_ACP_INSTALL_TIMEOUT_MS = 10 * 60_000;

type ClaudeAcpRuntimeMarker = {
  schemaVersion: 1;
  packageName: typeof CLAUDE_ACP_PACKAGE_NAME;
  version: typeof CLAUDE_ACP_VERSION;
  integrity: typeof CLAUDE_ACP_PACKAGE_INTEGRITY;
  nodeCommand: string;
  entrypoint: string;
  installedAt: number;
};

type ClaudeAcpRuntimeToolchain = {
  nodeCommand: string;
  npmCommand: string;
  npmArgsPrefix: string[];
};

export type ClaudeAcpRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  runtimeDirectory?: string;
  installId?: () => string;
  resolveToolchain?: (
    env: NodeJS.ProcessEnv,
  ) => Promise<ClaudeAcpRuntimeToolchain>;
  runInstaller?: (params: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<void>;
};

export function claudeAcpRuntimeDirectory(): string {
  if (getAppStateMode() === "bootstrap") {
    return resolveBootstrapProfilePath(CLAUDE_ACP_RUNTIME_DIRECTORY);
  }
  return resolveActiveProfilePath(CLAUDE_ACP_RUNTIME_DIRECTORY);
}

export function claudeAcpPlaceholderSettingsEntry(): AcpAgentSettingsEntry {
  return {
    backendId: CLAUDE_ACP_BACKEND_ID,
    registryId: CLAUDE_ACP_REGISTRY_ID,
    name: CLAUDE_ACP_NAME,
    description:
      "Experimental Claude support through the vetted Agent Client Protocol adapter managed by PwrAgent.",
    version: CLAUDE_ACP_VERSION,
    license: "Apache-2.0",
    authors: ["Agent Client Protocol contributors"],
    repositoryUrl: CLAUDE_ACP_REPOSITORY_URL,
    distributionKind: "npx",
    distributionSource: CLAUDE_ACP_PACKAGE_SPEC,
    installable: true,
    installed: false,
    installStatus: "not-installed",
    authStatus: "required",
    verificationStatus: "verified",
    allowlistRuleId: CLAUDE_ACP_ALLOWLIST_RULE_ID,
    managedRuntime: claudeAcpManagedRuntimeSummary(),
  };
}

export function claudeAcpManagedRuntimeSummary(
  record?: AcpInstalledAgentRecord,
): NonNullable<AcpAgentSettingsEntry["managedRuntime"]> {
  const descriptor = record?.launchDescriptor;
  return {
    kind: "pwragent-managed",
    packageName: CLAUDE_ACP_PACKAGE_NAME,
    pinnedVersion: CLAUDE_ACP_VERSION,
    integrity: CLAUDE_ACP_PACKAGE_INTEGRITY,
    credentialScope: "owning-instance",
    supportLevel: "experimental",
    authMethod: "local-terminal",
    subscriptionAuthBlocked: false,
    ...(descriptor
      ? {
          consoleAuthCommand: formatLocalCommand(
            descriptor.command,
            [
              descriptor.args[0] ?? "",
              "--cli",
              "auth",
              "login",
              "--console",
            ].filter(Boolean),
          ),
          subscriptionAuthCommand: formatLocalCommand(
            descriptor.command,
            [
              descriptor.args[0] ?? "",
              "--cli",
              "auth",
              "login",
              "--claudeai",
            ].filter(Boolean),
          ),
        }
      : {}),
  };
}

export async function discoverManagedClaudeAcpRuntime(
  options: ClaudeAcpRuntimeOptions = {},
): Promise<AcpInstalledAgentRecord | undefined> {
  const runtimeDirectory =
    options.runtimeDirectory ?? claudeAcpRuntimeDirectory();
  const marker = await readRuntimeMarker(runtimeDirectory);
  if (!marker) {
    return undefined;
  }
  const validated = await validateRuntimeInstallation(runtimeDirectory, marker);
  if (!validated) {
    return undefined;
  }
  return buildClaudeAcpInstalledRecord({
    marker,
    runtimeDirectory,
    entrypoint: validated.entrypoint,
    now: options.now?.() ?? Date.now(),
  });
}

export async function installManagedClaudeAcpRuntime(
  options: ClaudeAcpRuntimeOptions = {},
): Promise<AcpInstalledAgentRecord> {
  const runtimeDirectory =
    options.runtimeDirectory ?? claudeAcpRuntimeDirectory();
  const alreadyInstalled = await discoverManagedClaudeAcpRuntime({
    ...options,
    runtimeDirectory,
  });
  if (alreadyInstalled) {
    return alreadyInstalled;
  }

  const env = options.env ?? process.env;
  const resolveToolchain = options.resolveToolchain ?? resolveClaudeAcpToolchain;
  const toolchain = await resolveToolchain(env);
  const parentDirectory = path.dirname(runtimeDirectory);
  const installId = options.installId?.() ?? randomUUID();
  const stagingDirectory = path.join(parentDirectory, `.install-${installId}`);
  const replacedDirectory = path.join(parentDirectory, `.replaced-${installId}`);
  await mkdir(parentDirectory, { recursive: true });
  await mkdir(stagingDirectory, { recursive: false });

  const runInstaller = options.runInstaller ?? runNpmInstaller;
  let movedExisting = false;
  try {
    await runInstaller({
      command: toolchain.npmCommand,
      args: [
        ...toolchain.npmArgsPrefix,
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=true",
        "--save-exact",
        "--prefix",
        stagingDirectory,
        CLAUDE_ACP_PACKAGE_SPEC,
      ],
      cwd: stagingDirectory,
      env,
    });

    const packageRoot = path.join(
      stagingDirectory,
      "node_modules",
      "@agentclientprotocol",
      "claude-agent-acp",
    );
    const entrypoint = await validateInstalledPackage(
      stagingDirectory,
      packageRoot,
    );
    const installedAt = options.now?.() ?? Date.now();
    const marker: ClaudeAcpRuntimeMarker = {
      schemaVersion: 1,
      packageName: CLAUDE_ACP_PACKAGE_NAME,
      version: CLAUDE_ACP_VERSION,
      integrity: CLAUDE_ACP_PACKAGE_INTEGRITY,
      nodeCommand: toolchain.nodeCommand,
      entrypoint: path.relative(stagingDirectory, entrypoint),
      installedAt,
    };
    await writeRuntimeMarker(stagingDirectory, marker);

    if (await pathExists(runtimeDirectory)) {
      await rename(runtimeDirectory, replacedDirectory);
      movedExisting = true;
    }
    try {
      await rename(stagingDirectory, runtimeDirectory);
    } catch (promotionError) {
      // Several PwrAgent processes may share one profile. Another process can
      // win the atomic promotion after our existence check; accept only a
      // fully validated copy of the same pinned runtime in that case.
      const racedInstallation = await discoverManagedClaudeAcpRuntime({
        ...options,
        runtimeDirectory,
      });
      if (racedInstallation) {
        return racedInstallation;
      }
      throw promotionError;
    }
    if (movedExisting) {
      try {
        await removeScopedInstallDirectory(replacedDirectory, parentDirectory);
        movedExisting = false;
      } catch {
        // The finally block retries this scoped cleanup.
      }
    }

    const finalEntrypoint = path.join(runtimeDirectory, marker.entrypoint);
    return buildClaudeAcpInstalledRecord({
      marker,
      runtimeDirectory,
      entrypoint: finalEntrypoint,
      now: installedAt,
    });
  } catch (error) {
    if (movedExisting && !(await pathExists(runtimeDirectory))) {
      await rename(replacedDirectory, runtimeDirectory).catch(() => undefined);
      movedExisting = false;
    }
    throw normalizeInstallError(error);
  } finally {
    await removeScopedInstallDirectory(
      stagingDirectory,
      parentDirectory,
    ).catch(() => undefined);
    if (movedExisting) {
      await removeScopedInstallDirectory(
        replacedDirectory,
        parentDirectory,
      ).catch(() => undefined);
    }
  }
}

export function failedClaudeAcpInstallRecord(
  error: unknown,
  now = Date.now(),
): AcpInstalledAgentRecord {
  const message = error instanceof Error ? error.message : String(error);
  return {
    backendId: CLAUDE_ACP_BACKEND_ID,
    registryId: CLAUDE_ACP_REGISTRY_ID,
    name: CLAUDE_ACP_NAME,
    version: CLAUDE_ACP_VERSION,
    distributionKind: "npx",
    distributionSource: CLAUDE_ACP_PACKAGE_SPEC,
    installStatus: "install-failed",
    authStatus: "required",
    verificationStatus: "verified",
    allowlistRuleId: CLAUDE_ACP_ALLOWLIST_RULE_ID,
    installedAt: now,
    updatedAt: now,
    lastError: message,
    capabilities: acpAgentCapabilitiesForRegistryId(CLAUDE_ACP_REGISTRY_ID),
    registryAgent: claudeAcpRegistryAgent(),
  };
}

export function unavailableManagedClaudeAcpRuntime(
  record: AcpInstalledAgentRecord,
  now = Date.now(),
): AcpInstalledAgentRecord {
  const error =
    "The managed Claude runtime is missing or failed verification. Reinstall the pinned adapter.";
  return {
    ...record,
    name: CLAUDE_ACP_NAME,
    version: CLAUDE_ACP_VERSION,
    distributionKind: "npx",
    distributionSource: CLAUDE_ACP_PACKAGE_SPEC,
    installStatus: "unavailable",
    authStatus: "required",
    verificationStatus: "verified",
    allowlistRuleId: CLAUDE_ACP_ALLOWLIST_RULE_ID,
    updatedAt: Math.max(record.updatedAt, now),
    launchDescriptor: undefined,
    runtimeCapabilities: undefined,
    lastDiscoveredAt: now,
    lastDiscoveryError: error,
    lastError: error,
  };
}

export function isClaudeAcpAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:auth(?:entication|orization)?|credential|api[ _-]?key|login|sign[ -]?in|subscription)/i.test(
    message,
  );
}

function buildClaudeAcpInstalledRecord(params: {
  marker: ClaudeAcpRuntimeMarker;
  runtimeDirectory: string;
  entrypoint: string;
  now: number;
}): AcpInstalledAgentRecord {
  return {
    backendId: CLAUDE_ACP_BACKEND_ID,
    registryId: CLAUDE_ACP_REGISTRY_ID,
    name: CLAUDE_ACP_NAME,
    version: CLAUDE_ACP_VERSION,
    distributionKind: "npx",
    distributionSource: CLAUDE_ACP_PACKAGE_SPEC,
    installStatus: "installed",
    authStatus: "required",
    verificationStatus: "verified",
    allowlistRuleId: CLAUDE_ACP_ALLOWLIST_RULE_ID,
    installedAt: params.marker.installedAt,
    updatedAt: params.now,
    capabilities: acpAgentCapabilitiesForRegistryId(CLAUDE_ACP_REGISTRY_ID),
    launchDescriptor: {
      backendId: CLAUDE_ACP_BACKEND_ID,
      registryId: CLAUDE_ACP_REGISTRY_ID,
      distributionKind: "npx",
      command: params.marker.nodeCommand,
      args: [params.entrypoint],
      env: {},
      installPath: params.runtimeDirectory,
    },
    registryAgent: claudeAcpRegistryAgent(),
  };
}

function claudeAcpRegistryAgent(): AcpRegistryAgent {
  return {
    id: CLAUDE_ACP_REGISTRY_ID,
    backendId: CLAUDE_ACP_BACKEND_ID,
    name: CLAUDE_ACP_NAME,
    version: CLAUDE_ACP_VERSION,
    description:
      "Experimental Claude support through the external Agent Client Protocol adapter managed by PwrAgent.",
    authors: ["Agent Client Protocol contributors"],
    license: "Apache-2.0",
    repositoryUrl: CLAUDE_ACP_REPOSITORY_URL,
    distributions: [
      {
        kind: "npx",
        packageName: CLAUDE_ACP_PACKAGE_SPEC,
        args: [],
        env: {},
      },
    ],
    distributionKinds: ["npx"],
    auth: { required: true, methods: ["terminal"] },
    raw: {
      source: "pwragent-managed",
      credentialScope: "owning-instance",
      supportLevel: "experimental",
      subscriptionAuthBlocked: false,
    },
  };
}

async function resolveClaudeAcpToolchain(
  env: NodeJS.ProcessEnv,
): Promise<ClaudeAcpRuntimeToolchain> {
  const node = await buildCommandDiscoveryCandidate(
    { command: "node", source: "path" },
    {
      env,
      parseVersion: parseCliVersion,
      validateVersion: (version) => {
        const major = Number.parseInt(version.split(".")[0] ?? "", 10);
        return Number.isFinite(major) && major >= CLAUDE_ACP_MINIMUM_NODE_MAJOR
          ? undefined
          : `Node.js ${CLAUDE_ACP_MINIMUM_NODE_MAJOR} or newer is required`;
      },
    },
  );
  if (!node?.executable || !node.version) {
    throw new Error(
      `Claude setup requires Node.js ${CLAUDE_ACP_MINIMUM_NODE_MAJOR} or newer on the local PATH.`,
    );
  }
  const npm = await buildCommandDiscoveryCandidate(
    { command: "npm", source: "path" },
    { env, parseVersion: parseCliVersion },
  );
  if (!npm?.executable) {
    throw new Error("Claude setup requires npm on the local PATH.");
  }

  if ((process.platform as NodeJS.Platform) === "win32") {
    const npmCli = await resolveWindowsNpmCli(npm.command, node.command);
    if (!npmCli) {
      throw new Error("PwrAgent could not resolve npm's local CLI entrypoint.");
    }
    return {
      nodeCommand: node.command,
      npmCommand: node.command,
      npmArgsPrefix: [npmCli],
    };
  }
  return {
    nodeCommand: node.command,
    npmCommand: npm.command,
    npmArgsPrefix: [],
  };
}

async function resolveWindowsNpmCli(
  npmCommand: string,
  nodeCommand: string,
): Promise<string | undefined> {
  const candidates = [
    path.join(path.dirname(npmCommand), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(nodeCommand), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function runNpmInstaller(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await execFile(params.command, params.args, {
    cwd: params.cwd,
    env: buildPwrAgentChildProcessEnv(params.env),
    timeout: CLAUDE_ACP_INSTALL_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function validateInstalledPackage(
  runtimeDirectory: string,
  packageRoot: string,
): Promise<string> {
  const packageJson = await readJsonFile(path.join(packageRoot, "package.json"));
  if (
    packageJson.name !== CLAUDE_ACP_PACKAGE_NAME
    || packageJson.version !== CLAUDE_ACP_VERSION
  ) {
    throw new Error("The downloaded Claude ACP package did not match its version pin.");
  }
  const packageLock = await readJsonFile(
    path.join(runtimeDirectory, "package-lock.json"),
  );
  const lockPackages = asRecord(packageLock.packages);
  const lockedPackage = Object.entries(lockPackages ?? {}).find(([lockPath]) => {
    const normalized = lockPath.replace(/\\/g, "/");
    return normalized === CLAUDE_ACP_PACKAGE_LOCK_KEY
      || normalized.endsWith(`/${CLAUDE_ACP_PACKAGE_LOCK_KEY}`);
  })?.[1];
  const lockedPackageRecord = asRecord(lockedPackage);
  if (
    lockedPackageRecord?.version !== CLAUDE_ACP_VERSION
    || lockedPackageRecord.integrity !== CLAUDE_ACP_PACKAGE_INTEGRITY
  ) {
    throw new Error("The downloaded Claude ACP package failed integrity verification.");
  }
  const bin = typeof packageJson.bin === "string"
    ? packageJson.bin
    : readString(asRecord(packageJson.bin)?.[CLAUDE_ACP_BIN_NAME]);
  if (!bin) {
    throw new Error("The downloaded Claude ACP package has no executable entrypoint.");
  }
  const entrypoint = path.resolve(packageRoot, bin);
  if (!isPathInside(entrypoint, packageRoot) || !(await pathExists(entrypoint))) {
    throw new Error("The Claude ACP executable entrypoint is invalid.");
  }
  const [resolvedRuntime, resolvedPackageRoot, resolvedEntrypoint] =
    await Promise.all([
      realpath(runtimeDirectory),
      realpath(packageRoot),
      realpath(entrypoint),
    ]);
  if (
    !isPathInside(resolvedPackageRoot, resolvedRuntime)
    || !isPathInside(resolvedEntrypoint, resolvedPackageRoot)
  ) {
    throw new Error("The Claude ACP executable entrypoint escapes its package.");
  }
  return entrypoint;
}

async function validateRuntimeInstallation(
  runtimeDirectory: string,
  marker: ClaudeAcpRuntimeMarker,
): Promise<{ entrypoint: string } | undefined> {
  if (!path.isAbsolute(marker.nodeCommand)) {
    return undefined;
  }
  const entrypoint = path.resolve(runtimeDirectory, marker.entrypoint);
  if (!isPathInside(entrypoint, runtimeDirectory)) {
    return undefined;
  }
  try {
    const validatedEntrypoint = await validateInstalledPackage(
      runtimeDirectory,
      path.join(
        runtimeDirectory,
        "node_modules",
        "@agentclientprotocol",
        "claude-agent-acp",
      ),
    );
    if (validatedEntrypoint !== entrypoint) {
      return undefined;
    }
    await access(marker.nodeCommand);
    return { entrypoint };
  } catch {
    return undefined;
  }
}

async function readRuntimeMarker(
  runtimeDirectory: string,
): Promise<ClaudeAcpRuntimeMarker | undefined> {
  try {
    const value = await readJsonFile(
      path.join(runtimeDirectory, CLAUDE_ACP_MARKER_FILE),
    );
    if (
      value.schemaVersion !== 1
      || value.packageName !== CLAUDE_ACP_PACKAGE_NAME
      || value.version !== CLAUDE_ACP_VERSION
      || value.integrity !== CLAUDE_ACP_PACKAGE_INTEGRITY
      || typeof value.nodeCommand !== "string"
      || typeof value.entrypoint !== "string"
      || typeof value.installedAt !== "number"
    ) {
      return undefined;
    }
    return value as ClaudeAcpRuntimeMarker;
  } catch {
    return undefined;
  }
}

async function writeRuntimeMarker(
  runtimeDirectory: string,
  marker: ClaudeAcpRuntimeMarker,
): Promise<void> {
  await writeFile(
    path.join(runtimeDirectory, CLAUDE_ACP_MARKER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  return asRecord(JSON.parse(await readFile(filePath, "utf8"))) ?? {};
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeScopedInstallDirectory(
  directory: string,
  parentDirectory: string,
): Promise<void> {
  if (
    path.dirname(directory) !== parentDirectory
    || !/^\.(?:install|replaced)-[a-zA-Z0-9-]+$/.test(path.basename(directory))
  ) {
    throw new Error("Refusing to remove an unexpected Claude ACP runtime path.");
  }
  await rm(directory, { force: true, recursive: true });
}

function parseCliVersion(output: string): string | undefined {
  return /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output)?.[1];
}

function normalizeInstallError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/Node\.js \d+ or newer is required/i.test(message)) {
    return new Error(
      `Claude setup requires Node.js ${CLAUDE_ACP_MINIMUM_NODE_MAJOR} or newer on the local PATH.`,
    );
  }
  return new Error(`Claude ACP installation failed: ${message}`);
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function formatLocalCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteCommandArgument).join(" ");
}

function quoteCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9_@%+=:,./\\-]+$/.test(value)) {
    return value;
  }
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
