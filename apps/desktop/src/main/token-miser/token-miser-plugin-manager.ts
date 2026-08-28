import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCommandInvocation } from "@pwrdrvr/agent-transport";
import { TOKEN_MISER_BRIDGE_DESCRIPTOR_ENV } from "./token-miser-hook-bridge.js";

export const TOKEN_MISER_PLUGIN_NAME = "pwragent-token-miser";
/**
 * Pre-scoping marketplace name. Every profile registered under this one name
 * while pointing at its own per-profile root, so the first profile to activate
 * claimed it and every other profile's `marketplace add` failed with "already
 * added from a different source" — the gate then failed open and ran nothing,
 * with only a log line to say so. Kept so a profile can retire its own stale
 * registration.
 */
export const TOKEN_MISER_LEGACY_MARKETPLACE_NAME = "pwragent-local";

/**
 * Codex keys marketplaces by name, and the root is per-profile, so the name has
 * to be per-profile too.
 */
export function buildTokenMiserMarketplaceName(profileName: string): string {
  const slug = profileName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 48);
  return slug ? `pwragent-local-${slug}` : TOKEN_MISER_LEGACY_MARKETPLACE_NAME;
}

const CODEX_PLUGIN_COMMAND_TIMEOUT_MS = 30_000;
const CODEX_PLUGIN_COMMAND_OUTPUT_LIMIT = 64 * 1024;

type CodexPluginCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Best-effort cleanup: a missing entry is success, not a failure. */
  tolerateFailure?: boolean;
};

export class TokenMiserPluginManager {
  constructor(
    private readonly options: {
      stateDir: string;
      /** Scopes the Codex marketplace name; the root is already per-profile. */
      profileName: string;
      executablePath: string;
      hookEntryPath: string;
      platform?: NodeJS.Platform;
      runCodexCommand?: (command: CodexPluginCommand) => Promise<void>;
    },
  ) {}

  private readonly installedRuntimeKeys = new Set<string>();
  private readonly installationPromises = new Map<string, Promise<void>>();
  private pluginSourcePromise:
    | Promise<{
        marketplacePath: string;
        marketplaceRoot: string;
        pluginPath: string;
      }>
    | undefined;

  async ensurePluginSource(): Promise<{
    marketplacePath: string;
    marketplaceRoot: string;
    pluginPath: string;
  }> {
    const pending = this.pluginSourcePromise;
    if (pending) {
      return pending;
    }
    const installation = this.writePluginSource();
    this.pluginSourcePromise = installation;
    try {
      return await installation;
    } finally {
      if (this.pluginSourcePromise === installation) {
        this.pluginSourcePromise = undefined;
      }
    }
  }

  private async writePluginSource(): Promise<{
    marketplacePath: string;
    marketplaceRoot: string;
    pluginPath: string;
  }> {
    const marketplaceRoot = path.join(this.options.stateDir, "marketplace");
    const marketplacePath = path.join(
      marketplaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    const pluginPath = path.join(
      marketplaceRoot,
      "plugins",
      TOKEN_MISER_PLUGIN_NAME,
    );
    const manifestDir = path.join(pluginPath, ".codex-plugin");
    const hooksDir = path.join(pluginPath, "hooks");
    await Promise.all([
      fs.mkdir(manifestDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(hooksDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(path.dirname(marketplacePath), {
        recursive: true,
        mode: 0o700,
      }),
    ]);
    await Promise.all([
      writePrivateJsonAtomic(path.join(manifestDir, "plugin.json"), {
        name: TOKEN_MISER_PLUGIN_NAME,
        version: "0.1.0",
        description: "PwrAgent Token Miser oversized tool-output gate.",
        author: { name: "PwrDrvr LLC" },
        license: "MIT",
        interface: {
          displayName: "Token Miser",
          shortDescription: "Summarize oversized tool output before replay.",
          longDescription:
            "A PwrAgent-managed Codex hook that preserves large tool output and replaces it with a bounded, retrievable summary.",
          developerName: "PwrDrvr LLC",
          category: "Developer Tools",
          capabilities: ["Lifecycle hooks"],
          defaultPrompt: [
            "Explain how Token Miser protects this thread from large tool output.",
          ],
        },
      }),
      writePrivateJsonAtomic(path.join(hooksDir, "hooks.json"), {
        description: "PwrAgent Token Miser lifecycle hook.",
        hooks: {
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: buildHookCommand({
                    executablePath: this.options.executablePath,
                    hookEntryPath: this.options.hookEntryPath,
                    platform: this.options.platform ?? process.platform,
                  }),
                  timeout: 60,
                  statusMessage: "Token Miser is checking large tool output",
                },
              ],
            },
          ],
        },
      }),
      writePrivateJsonAtomic(marketplacePath, {
        name: buildTokenMiserMarketplaceName(this.options.profileName),
        interface: { displayName: "PwrAgent Local" },
        plugins: [
          {
            name: TOKEN_MISER_PLUGIN_NAME,
            source: {
              source: "local",
              path: `./plugins/${TOKEN_MISER_PLUGIN_NAME}`,
            },
            policy: {
              installation: "AVAILABLE",
              authentication: "ON_INSTALL",
            },
            category: "Developer Tools",
          },
        ],
      }),
    ]);
    return {
      marketplacePath,
      marketplaceRoot,
      pluginPath,
    };
  }

  async ensureInstalled(params: {
    codexCommand: string;
    codexEnv: NodeJS.ProcessEnv;
  }): Promise<void> {
    const source = await this.ensurePluginSource();
    const codexHome = params.codexEnv.CODEX_HOME?.trim()
      || path.join(os.homedir(), ".codex");
    const runtimeKey = `${path.resolve(codexHome)}\0${params.codexCommand}`;
    if (this.installedRuntimeKeys.has(runtimeKey)) {
      return;
    }
    const pending = this.installationPromises.get(runtimeKey);
    if (pending) {
      await pending;
      return;
    }
    const installation = this.installForRuntime({
      ...params,
      marketplaceRoot: source.marketplaceRoot,
    });
    this.installationPromises.set(runtimeKey, installation);
    try {
      await installation;
      this.installedRuntimeKeys.add(runtimeKey);
    } finally {
      this.installationPromises.delete(runtimeKey);
    }
  }

  private async installForRuntime(params: {
    codexCommand: string;
    codexEnv: NodeJS.ProcessEnv;
    marketplaceRoot: string;
  }): Promise<void> {
    const run = this.options.runCodexCommand ?? ((command) =>
      runCodexPluginCommand(command, this.options.platform ?? process.platform));
    // Retire this profile's own pre-scoping registration first. Scoped only by
    // our own root, so a profile can never remove another profile's entry —
    // each one cleans up after itself the next time it activates.
    await run({
      command: params.codexCommand,
      args: [
        "plugin",
        "marketplace",
        "remove",
        TOKEN_MISER_LEGACY_MARKETPLACE_NAME,
        "--json",
      ],
      env: params.codexEnv,
      tolerateFailure: true,
    });
    await run({
      command: params.codexCommand,
      args: [
        "plugin",
        "marketplace",
        "add",
        params.marketplaceRoot,
        "--json",
      ],
      env: params.codexEnv,
    });
    await run({
      command: params.codexCommand,
      args: [
        "plugin",
        "add",
        `${TOKEN_MISER_PLUGIN_NAME}@${buildTokenMiserMarketplaceName(this.options.profileName)}`,
        "--json",
      ],
      env: params.codexEnv,
    });
  }
}

export function buildHookCommand(params: {
  executablePath: string;
  hookEntryPath: string;
  platform: NodeJS.Platform;
}): string {
  if (params.platform === "win32") {
    return [
      'set "ELECTRON_RUN_AS_NODE=1"',
      [
        quoteWindows(params.executablePath),
        quoteWindows(params.hookEntryPath),
        `"%${TOKEN_MISER_BRIDGE_DESCRIPTOR_ENV}%"`,
      ].join(" "),
    ].join(" && ");
  }
  return [
    "ELECTRON_RUN_AS_NODE=1",
    quotePosix(params.executablePath),
    quotePosix(params.hookEntryPath),
    `"$${TOKEN_MISER_BRIDGE_DESCRIPTOR_ENV}"`,
  ].join(" ");
}

async function writePrivateJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
}

async function runCodexPluginCommand(
  command: CodexPluginCommand,
  platform: NodeJS.Platform,
): Promise<void> {
  const invocation = createCommandInvocation({
    command: command.command,
    args: command.args,
    env: command.env,
    platform,
  });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let output = "";
    const appendOutput = (chunk: Buffer | string): void => {
      if (output.length >= CODEX_PLUGIN_COMMAND_OUTPUT_LIMIT) {
        return;
      }
      output += chunk.toString().slice(
        0,
        CODEX_PLUGIN_COMMAND_OUTPUT_LIMIT - output.length,
      );
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Codex plugin activation timed out."));
    }, CODEX_PLUGIN_COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      if (command.tolerateFailure) {
        // Best-effort cleanup: nothing to remove is the expected case.
        resolve();
        return;
      }
      reject(new Error(
        `Codex plugin activation failed with exit code ${code ?? "unknown"}: ${output.trim()}`,
      ));
    });
  });
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteWindows(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
