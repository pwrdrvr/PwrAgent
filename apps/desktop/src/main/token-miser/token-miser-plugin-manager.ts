import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const TOKEN_MISER_PLUGIN_NAME = "pwragent-token-miser";
export const TOKEN_MISER_MARKETPLACE_NAME = "pwragent-local";

export class TokenMiserPluginManager {
  constructor(
    private readonly options: {
      stateDir: string;
      executablePath: string;
      hookEntryPath: string;
      platform?: NodeJS.Platform;
    },
  ) {}

  async ensurePluginSource(): Promise<{
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
    const descriptorPath = path.join(this.options.stateDir, "bridge.json");
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
                    descriptorPath,
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
        name: TOKEN_MISER_MARKETPLACE_NAME,
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
}

export function buildHookCommand(params: {
  descriptorPath: string;
  executablePath: string;
  hookEntryPath: string;
  platform: NodeJS.Platform;
}): string {
  if (params.platform === "win32") {
    return [
      'set "ELECTRON_RUN_AS_NODE=1"',
      quoteWindows(params.executablePath),
      quoteWindows(params.hookEntryPath),
      quoteWindows(params.descriptorPath),
    ].join(" && ");
  }
  return [
    "ELECTRON_RUN_AS_NODE=1",
    quotePosix(params.executablePath),
    quotePosix(params.hookEntryPath),
    quotePosix(params.descriptorPath),
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

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteWindows(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
