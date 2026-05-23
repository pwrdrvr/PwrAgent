import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { AcpBackendId } from "@pwragent/shared";
import { acpAgentCapabilitiesForRegistryId } from "./acp-agent-capabilities.js";
import { normalizeAcpLaunchDescriptor } from "./acp-launch-descriptor.js";
import type { AcpInstalledAgentRecord } from "./acp-registry-types.js";

const execFile = promisify(execFileCallback);

export type LocalAcpProbeResult = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

export type LocalAcpAgentProbe = (
  command: string,
  args: string[],
) => Promise<LocalAcpProbeResult>;

export async function discoverLocalAcpAgents(options?: {
  probe?: LocalAcpAgentProbe;
  now?: () => number;
}): Promise<AcpInstalledAgentRecord[]> {
  const gemini = await discoverLocalGemini(options);
  return gemini ? [gemini] : [];
}

async function discoverLocalGemini(options?: {
  probe?: LocalAcpAgentProbe;
  now?: () => number;
}): Promise<AcpInstalledAgentRecord | undefined> {
  const probe = options?.probe ?? defaultProbe;
  const [versionResult, helpResult] = await Promise.all([
    probeCommand(probe, "gemini", ["--version"]),
    probeCommand(probe, "gemini", ["--help"]),
  ]);
  if (!versionResult || !helpResult) {
    return undefined;
  }

  const helpText = resultText(helpResult);
  if (!/(^|\s)--acp(\s|,|$)/.test(helpText)) {
    return undefined;
  }

  const now = options?.now?.() ?? Date.now();
  const backendId = "acp:gemini" as AcpBackendId;
  const version = parseGeminiVersion(resultText(versionResult));
  return {
    backendId,
    registryId: "gemini",
    name: "Gemini CLI",
    version,
    distributionKind: "local",
    distributionSource: "gemini --acp --skip-trust",
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    allowlistRuleId: "local-gemini-cli",
    installedAt: now,
    updatedAt: now,
    capabilities: acpAgentCapabilitiesForRegistryId("gemini"),
    launchDescriptor: normalizeAcpLaunchDescriptor({
      backendId,
      registryId: "gemini",
      distributionKind: "local",
      command: "gemini",
      args: ["--acp"],
      env: {},
    }),
    registryAgent: {
      id: "gemini",
      backendId,
      name: "Gemini CLI",
      version,
      authors: ["Google"],
      distributions: [],
      distributionKinds: ["local"],
      auth: { required: false, methods: ["agent-managed"] },
      raw: { source: "local-cli" },
    },
  };
}

async function defaultProbe(
  command: string,
  args: string[],
): Promise<LocalAcpProbeResult> {
  return await execFile(command, args, {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
}

async function probeCommand(
  probe: LocalAcpAgentProbe,
  command: string,
  args: string[],
): Promise<LocalAcpProbeResult | undefined> {
  try {
    return await probe(command, args);
  } catch {
    return undefined;
  }
}

function resultText(result: LocalAcpProbeResult): string {
  return [result.stdout, result.stderr]
    .flatMap((value) => value === undefined ? [] : [value])
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : value)
    .join("\n");
}

function parseGeminiVersion(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? trimmed;
}
