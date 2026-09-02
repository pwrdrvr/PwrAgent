import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const EXPECTED_REGISTRATION_KEYS = new Set([
  "disabled_reason",
  "disabled_tools",
  "enabled",
  "enabled_tools",
  "name",
  "startup_timeout_sec",
  "tool_timeout_sec",
  "transport",
]);
const EXPECTED_TRANSPORT_KEYS = new Set([
  "args",
  "command",
  "cwd",
  "env",
  "env_vars",
  "type",
]);

export const DEFAULT_CHATGPT_APP = "/Applications/ChatGPT.app";
export const LAUNCHER_BACKUP_FILENAME = "node-repl-launcher-before-sky-trampoline.json";
export const NODE_REPL_SERVER_NAME = "node_repl";
export const TRAMPOLINE_FILENAME = "openai-node-repl-trampoline.cjs";

function readOptionValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseArgs(args) {
  let mode = "status";
  let modeSelected = false;
  let chatgptApp = DEFAULT_CHATGPT_APP;
  let codexCommand;
  let pwragentRoot;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--apply" || argument === "--restore" || argument === "--status") {
      if (modeSelected) {
        throw new Error("Select exactly one of --apply, --restore, or --status");
      }
      modeSelected = true;
      mode = argument.slice(2);
      continue;
    }
    if (argument === "--chatgpt-app") {
      chatgptApp = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--codex") {
      codexCommand = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--pwragent-root") {
      pwragentRoot = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    chatgptApp: path.resolve(chatgptApp),
    codexCommand: codexCommand ? path.resolve(codexCommand) : undefined,
    mode,
    pwragentRoot: pwragentRoot ? path.resolve(pwragentRoot) : undefined,
  };
}

function readStringRecord(value, label) {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
    result[key] = entry;
  }
  return result;
}

export function readNodeReplRegistration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex returned an invalid node_repl registration");
  }
  const transport = value.transport;
  if (!transport || typeof transport !== "object" || Array.isArray(transport)) {
    throw new Error("Codex node_repl registration has no transport");
  }
  if (transport.type !== "stdio") {
    throw new Error(`Codex node_repl transport must be stdio, got ${String(transport.type)}`);
  }
  if (typeof transport.command !== "string" || !transport.command.trim()) {
    throw new Error("Codex node_repl registration has no command");
  }
  if (!Array.isArray(transport.args) || !transport.args.every((entry) => typeof entry === "string")) {
    throw new Error("Codex node_repl registration has invalid arguments");
  }

  const unsupportedSettings = [];
  for (const key of Object.keys(value)) {
    if (!EXPECTED_REGISTRATION_KEYS.has(key)) {
      unsupportedSettings.push(key);
    }
  }
  for (const key of Object.keys(transport)) {
    if (!EXPECTED_TRANSPORT_KEYS.has(key)) {
      unsupportedSettings.push(`transport.${key}`);
    }
  }
  if (value.name !== undefined && value.name !== NODE_REPL_SERVER_NAME) {
    unsupportedSettings.push("name");
  }
  if (value.enabled !== undefined && value.enabled !== true) {
    unsupportedSettings.push("enabled");
  }
  for (const key of [
    "disabled_reason",
    "disabled_tools",
    "enabled_tools",
    "startup_timeout_sec",
    "tool_timeout_sec",
  ]) {
    if (value[key] !== undefined && value[key] !== null) {
      unsupportedSettings.push(key);
    }
  }
  if (transport.cwd !== undefined && transport.cwd !== null) {
    unsupportedSettings.push("transport.cwd");
  }
  if (
    transport.env_vars !== undefined
    && (!Array.isArray(transport.env_vars) || transport.env_vars.length > 0)
  ) {
    unsupportedSettings.push("transport.env_vars");
  }
  if (unsupportedSettings.length > 0) {
    throw new Error(
      `Codex node_repl registration has unsupported settings: ${[
        ...new Set(unsupportedSettings),
      ].sort().join(", ")}`,
    );
  }

  return {
    args: [...transport.args],
    command: transport.command,
    env: readStringRecord(transport.env, "node_repl environment"),
  };
}

export function readLauncherBackup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The node_repl launcher backup is invalid");
  }
  if (value.version !== 1) {
    throw new Error(`Unsupported node_repl launcher backup version: ${String(value.version)}`);
  }
  if (typeof value.command !== "string" || !value.command.trim()) {
    throw new Error("The node_repl launcher backup has no command");
  }
  if (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string")) {
    throw new Error("The node_repl launcher backup has invalid arguments");
  }
  return {
    args: [...value.args],
    command: value.command,
  };
}

export function buildMcpAddArgs(registration, command, args) {
  const commandArgs = ["mcp", "add"];
  for (const [key, value] of Object.entries(registration.env)) {
    commandArgs.push("--env", `${key}=${value}`);
  }
  commandArgs.push(NODE_REPL_SERVER_NAME, "--", command, ...args);
  return commandArgs;
}

export function createSafeCodexCommandError(action, error) {
  const details = [];
  const code = error && typeof error === "object" ? error.code : undefined;
  const signal = error && typeof error === "object" ? error.signal : undefined;
  if (
    typeof code === "number"
    || (typeof code === "string" && /^[A-Z0-9_-]+$/.test(code))
  ) {
    details.push(`code ${code}`);
  }
  if (typeof signal === "string" && /^[A-Z0-9_-]+$/.test(signal)) {
    details.push(`signal ${signal}`);
  }
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return new Error(`Codex ${action} failed${suffix}`);
}

export function renderTrampoline(nodeReplPath) {
  return `"use strict";

const { spawn } = require("node:child_process");

const nodeReplPath = ${JSON.stringify(nodeReplPath)};
const child = spawn(nodeReplPath, process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
});

let exiting = false;
const signalHandlers = new Map();

function forwardSignal(signal) {
  if (!exiting) {
    child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) {
  const handler = () => forwardSignal(signal);
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
}

child.on("error", (error) => {
  console.error(\`Failed to launch the bundled node_repl: \${error.message}\`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  exiting = true;
  removeSignalHandlers();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
`;
}

export function registrationsMatch(left, right) {
  return left.command === right.command
    && JSON.stringify(left.args) === JSON.stringify(right.args)
    && Object.keys(left.env).length === Object.keys(right.env).length
    && Object.entries(left.env).every(([key, value]) => right.env[key] === value);
}

export function isManagedTrampolineRegistration(registration) {
  const expectedNodeSuffix = path.join(
    "Contents",
    "Resources",
    "cua_node",
    "bin",
    "node",
  );
  return registration.args.length === 1
    && path.basename(registration.args[0]) === TRAMPOLINE_FILENAME
    && path.normalize(registration.command).endsWith(expectedNodeSuffix);
}

export function originalLauncherForApply(current, expected, backup) {
  if (registrationsMatch(current, expected)) {
    return undefined;
  }
  if (isManagedTrampolineRegistration(current)) {
    if (!backup) {
      throw new Error(
        "The installed Sky trampoline has no original-launcher backup; restore it before migrating paths",
      );
    }
    return backup;
  }
  return {
    args: current.args,
    command: current.command,
  };
}

export function resolvePwragentRoot(explicitRoot, environmentRoot, homeDir) {
  const configuredRoot = explicitRoot ?? environmentRoot?.trim();
  return configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(homeDir, ".pwragent");
}

async function runCodexCommand(codexCommand, args, action) {
  try {
    return await execFile(codexCommand, args, { maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw createSafeCodexCommandError(action, error);
  }
}

async function readRegistration(codexCommand) {
  const { stdout } = await runCodexCommand(
    codexCommand,
    ["mcp", "get", NODE_REPL_SERVER_NAME, "--json"],
    "mcp get node_repl",
  );
  return readNodeReplRegistration(JSON.parse(stdout));
}

async function removeRegistration(codexCommand) {
  await runCodexCommand(
    codexCommand,
    ["mcp", "remove", NODE_REPL_SERVER_NAME],
    "mcp remove node_repl",
  );
}

async function addRegistration(codexCommand, registration, command, args) {
  await runCodexCommand(
    codexCommand,
    buildMcpAddArgs(registration, command, args),
    "mcp add node_repl",
  );
}

async function readLauncherBackupFile(backupPath) {
  try {
    return readLauncherBackup(JSON.parse(await readFile(backupPath, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function replaceRegistration({
  codexCommand,
  current,
  desiredArgs,
  desiredCommand,
}) {
  await removeRegistration(codexCommand);
  try {
    await addRegistration(codexCommand, current, desiredCommand, desiredArgs);
    const updated = await readRegistration(codexCommand);
    const desired = {
      args: desiredArgs,
      command: desiredCommand,
      env: current.env,
    };
    if (!registrationsMatch(updated, desired)) {
      throw new Error("Codex did not preserve the requested node_repl registration");
    }
    return updated;
  } catch (error) {
    try {
      await removeRegistration(codexCommand);
    } catch {
      // The failed add may have left no registration to remove.
    }
    try {
      await addRegistration(codexCommand, current, current.command, current.args);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Updating node_repl failed and the original registration could not be restored",
      );
    }
    throw error;
  }
}

function printStatus(registration, expected) {
  const applied = registration.command === expected.command
    && JSON.stringify(registration.args) === JSON.stringify(expected.args);
  console.log(JSON.stringify({
    applied,
    args: registration.args,
    command: registration.command,
    environmentVariableCount: Object.keys(registration.env).length,
  }, null, 2));
}

export async function main(args = process.argv.slice(2), runtime = {}) {
  const options = parseArgs(args);
  if ((runtime.platform ?? process.platform) !== "darwin") {
    throw new Error("The Sky Computer Use signing workaround is macOS-only");
  }

  const resources = path.join(options.chatgptApp, "Contents", "Resources");
  const signedNode = path.join(resources, "cua_node", "bin", "node");
  const nodeRepl = path.join(resources, "cua_node", "bin", "node_repl");
  const codexCommand = options.codexCommand ?? path.join(resources, "codex");
  const pwragentRoot = resolvePwragentRoot(
    options.pwragentRoot,
    process.env.PWRAGENT_HOME,
    os.homedir(),
  );
  const localRoot = path.join(pwragentRoot, "local");
  const backupPath = path.join(localRoot, LAUNCHER_BACKUP_FILENAME);
  const trampoline = path.join(localRoot, TRAMPOLINE_FILENAME);

  await Promise.all([
    access(codexCommand, fsConstants.X_OK),
    access(signedNode, fsConstants.X_OK),
    access(nodeRepl, fsConstants.X_OK),
  ]);

  const current = await readRegistration(codexCommand);
  const expected = {
    args: [trampoline],
    command: signedNode,
    env: current.env,
  };

  if (options.mode === "status") {
    printStatus(current, expected);
    return;
  }

  if (options.mode === "restore") {
    const installedBackupPath = isManagedTrampolineRegistration(current)
      ? path.join(path.dirname(current.args[0]), LAUNCHER_BACKUP_FILENAME)
      : backupPath;
    const backup = await readLauncherBackupFile(installedBackupPath);
    const restored = await replaceRegistration({
      codexCommand,
      current,
      desiredArgs: backup?.args ?? [],
      desiredCommand: backup?.command ?? nodeRepl,
    });
    printStatus(restored, expected);
    console.log("Restored the direct node_repl launcher. Restart Codex MCP servers to apply it.");
    return;
  }

  await mkdir(localRoot, { recursive: true });
  const installedBackupPath = isManagedTrampolineRegistration(current)
    ? path.join(path.dirname(current.args[0]), LAUNCHER_BACKUP_FILENAME)
    : undefined;
  const installedBackup = installedBackupPath
    ? await readLauncherBackupFile(installedBackupPath)
    : undefined;
  const originalLauncher = originalLauncherForApply(
    current,
    expected,
    installedBackup,
  );
  if (originalLauncher) {
    await writeFile(backupPath, `${JSON.stringify({
      args: originalLauncher.args,
      command: originalLauncher.command,
      version: 1,
    }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  await writeFile(trampoline, renderTrampoline(nodeRepl), {
    encoding: "utf8",
    mode: 0o644,
  });

  const updated = registrationsMatch(current, expected)
    ? current
    : await replaceRegistration({
        codexCommand,
        current,
        desiredArgs: expected.args,
        desiredCommand: expected.command,
      });
  printStatus(updated, expected);
  console.log("Installed the signed-node trampoline. Restart Codex MCP servers to apply it.");
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
