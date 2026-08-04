import { execFile as execFileCallback } from "node:child_process";
import type {
  ConfigureFederationTailscaleRequest,
  ConfigureFederationTailscaleResponse,
  FederationTailscaleStatus,
} from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { discoverCommands } from "../settings/command-discovery";

const PWRAGENT_TAILSCALE_PATH = "/pwragent-federation";
const COMMAND_TIMEOUT_MS = 15_000;

type TailscaleCommandSource = "path" | "application";

type TailscaleCommand = {
  command: string;
  version?: string;
};

type TailscaleCommandResult = {
  stdout: string;
  stderr: string;
};

type FederationTailscaleServiceOptions = {
  discoverCommand?: () => Promise<TailscaleCommand | undefined>;
  env?: NodeJS.ProcessEnv;
  runCommand?: (
    command: string,
    args: string[],
  ) => Promise<TailscaleCommandResult>;
};

export class FederationTailscaleService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly discoverCommandOverride?: FederationTailscaleServiceOptions["discoverCommand"];
  private readonly runCommandOverride?: FederationTailscaleServiceOptions["runCommand"];

  constructor(options: FederationTailscaleServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.discoverCommandOverride = options.discoverCommand;
    this.runCommandOverride = options.runCommand;
  }

  async readStatus(): Promise<FederationTailscaleStatus> {
    const discovered = await this.discoverCommand();
    if (!discovered) {
      return {
        installed: false,
        connected: false,
        serveConfigured: false,
        funnelConfigured: false,
        unavailableReason: "Tailscale CLI was not found.",
      };
    }

    try {
      const [statusResult, serveResult, funnelResult] = await Promise.all([
        this.runCommand(discovered.command, ["status", "--json"]),
        this.runCommand(discovered.command, ["serve", "status", "--json"]),
        this.runCommand(discovered.command, ["funnel", "status", "--json"]),
      ]);
      const statusJson = parseJsonObject(statusResult.stdout, "Tailscale status");
      const self = readObject(statusJson.Self);
      const currentTailnet = readObject(statusJson.CurrentTailnet);
      const dnsName = readString(self?.DNSName)?.replace(/\.$/, "");
      const backendState = readString(statusJson.BackendState);
      const connected = self?.Online === true || backendState === "Running";

      return {
        installed: true,
        connected,
        version: discovered.version,
        backendState,
        dnsName,
        tailnetName: readString(currentTailnet?.Name),
        serveConfigured: hasPwrAgentHandler(serveResult.stdout),
        funnelConfigured: hasPwrAgentHandler(funnelResult.stdout),
        gatewayUrl: dnsName ? buildGatewayUrl(dnsName) : undefined,
        unavailableReason: connected
          ? undefined
          : "Tailscale is installed but this device is not connected.",
      };
    } catch (error) {
      return {
        installed: true,
        connected: false,
        version: discovered.version,
        serveConfigured: false,
        funnelConfigured: false,
        unavailableReason: errorMessage(error),
      };
    }
  }

  async configure(
    request: ConfigureFederationTailscaleRequest,
  ): Promise<ConfigureFederationTailscaleResponse> {
    if (!Number.isInteger(request.listenPort) || request.listenPort < 1 || request.listenPort > 65_535) {
      throw new Error("Tailscale setup requires a valid federation listen port.");
    }
    if (request.mode !== "serve" && request.mode !== "funnel") {
      throw new Error("Unsupported Tailscale federation mode.");
    }

    const discovered = await this.discoverCommand();
    if (!discovered) {
      throw new Error("Tailscale CLI was not found.");
    }

    const before = await this.readStatus();
    if (!before.connected) {
      throw new Error(
        before.unavailableReason ?? "Connect this device to Tailscale before setup.",
      );
    }

    await this.runCommand(discovered.command, [
      request.mode,
      "--bg",
      "--yes",
      `--set-path=${PWRAGENT_TAILSCALE_PATH}`,
      `http://127.0.0.1:${request.listenPort}`,
    ]);

    const status = await this.readStatus();
    if (!status.gatewayUrl) {
      throw new Error("Tailscale did not report a MagicDNS name after setup.");
    }
    if (request.mode === "serve" && !status.serveConfigured) {
      throw new Error("Tailscale Serve did not report the PwrAgent handler after setup.");
    }
    if (request.mode === "funnel" && !status.funnelConfigured) {
      throw new Error("Tailscale Funnel did not report the PwrAgent handler after setup.");
    }

    return {
      status,
      gatewayUrl: status.gatewayUrl,
    };
  }

  private async discoverCommand(): Promise<TailscaleCommand | undefined> {
    if (this.discoverCommandOverride) {
      return await this.discoverCommandOverride();
    }
    const discovery = await discoverCommands<TailscaleCommandSource>({
      fixedCandidates: [],
      autoCandidates: [
        { command: "tailscale", source: "path" },
        {
          command: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          source: "application",
        },
      ],
      env: this.env,
      parseVersion: (output) => output.match(/\b\d+\.\d+(?:\.\d+)?\b/)?.[0],
      includeFailedAutoCandidates: "if-none-executable",
    });
    const selected = discovery.candidates.find((candidate) => candidate.selected);
    return selected
      ? { command: selected.command, version: selected.version }
      : undefined;
  }

  private async runCommand(
    command: string,
    args: string[],
  ): Promise<TailscaleCommandResult> {
    if (this.runCommandOverride) {
      return await this.runCommandOverride(command, args);
    }
    return await new Promise<TailscaleCommandResult>((resolve, reject) => {
      execFileCallback(
        command,
        args,
        {
          env: buildPwrAgentChildProcessEnv(this.env),
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = `${stderr || stdout}`.trim();
            reject(new Error(detail || error.message));
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    const object = readObject(parsed);
    if (!object) {
      throw new Error(`${label} did not return an object.`);
    }
    return object;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} returned invalid JSON.`, { cause: error });
    }
    throw error;
  }
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasPwrAgentHandler(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return JSON.stringify(parsed).includes(PWRAGENT_TAILSCALE_PATH);
  } catch {
    return false;
  }
}

function buildGatewayUrl(dnsName: string): string {
  return `wss://${dnsName}${PWRAGENT_TAILSCALE_PATH}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let federationTailscaleService: FederationTailscaleService | undefined;

export function getFederationTailscaleService(): FederationTailscaleService {
  federationTailscaleService ??= new FederationTailscaleService();
  return federationTailscaleService;
}
