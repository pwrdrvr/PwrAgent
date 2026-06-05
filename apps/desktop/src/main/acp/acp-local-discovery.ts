import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
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

export type LocalAcpDiscoveryOptions = {
  probe?: LocalAcpAgentProbe;
  now?: () => number;
  /**
   * Per-agent path overrides. When set, the override path is tried first;
   * if it succeeds the bare command name probe is skipped.
   */
  overrides?: {
    grok?: string;
    qwen?: string;
    kimi?: string;
  };
};

export async function discoverLocalAcpAgents(
  options?: LocalAcpDiscoveryOptions,
): Promise<AcpInstalledAgentRecord[]> {
  const discovered = await Promise.all([
    discoverLocalGemini(options),
    discoverLocalKimi(options),
    discoverLocalGrok(options),
    discoverLocalQwen(options),
  ]);
  return discovered.filter((agent): agent is AcpInstalledAgentRecord =>
    Boolean(agent)
  );
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

async function discoverLocalKimi(
  options?: LocalAcpDiscoveryOptions,
): Promise<AcpInstalledAgentRecord | undefined> {
  const probe = options?.probe ?? defaultProbe;
  const candidates = kimiCandidatePaths(options?.overrides?.kimi);
  for (const command of candidates) {
    const [versionResult, acpHelpResult] = await Promise.all([
      probeCommand(probe, command, ["--version"]),
      probeCommand(probe, command, ["acp", "--help"]),
    ]);
    if (!versionResult || !acpHelpResult) {
      continue;
    }

    // The capability signal is simply that `kimi acp --help` ran with a zero
    // exit code (probeCommand returns undefined on non-zero / spawn failure,
    // handled above). kimi's commander-style CLI exits non-zero for an unknown
    // subcommand, so a clean `acp --help` proves the `acp` subcommand exists.
    // We deliberately do NOT parse the help prose — it changed across kimi
    // versions (0.11.0 prints "Agent Client Protocol (ACP) server", earlier
    // builds printed "...ACP server"), and a fragile string match made an
    // installed, working kimi undiscoverable.

    const now = options?.now?.() ?? Date.now();
    const backendId = "acp:kimi" as AcpBackendId;
    const version = parseCliVersion(resultText(versionResult));
    return {
      backendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      version,
      distributionKind: "local",
      distributionSource: `${command} acp`,
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: "local-kimi-cli",
      installedAt: now,
      updatedAt: now,
      capabilities: acpAgentCapabilitiesForRegistryId("kimi"),
      launchDescriptor: normalizeAcpLaunchDescriptor({
        backendId,
        registryId: "kimi",
        distributionKind: "local",
        command,
        args: ["acp"],
        env: {},
      }),
      registryAgent: {
        id: "kimi",
        backendId,
        name: "Kimi Code CLI",
        version,
        authors: ["Moonshot AI"],
        distributions: [],
        distributionKinds: ["local"],
        auth: { required: false, methods: ["agent-managed"] },
        raw: { source: "local-cli" },
      },
    };
  }
  return undefined;
}

async function discoverLocalGrok(
  options?: LocalAcpDiscoveryOptions,
): Promise<AcpInstalledAgentRecord | undefined> {
  const probe = options?.probe ?? defaultProbe;
  const candidates = grokCandidatePaths(options?.overrides?.grok);
  for (const command of candidates) {
    const [versionResult, stdioHelpResult] = await Promise.all([
      probeCommand(probe, command, ["--version"]),
      probeCommand(probe, command, ["agent", "stdio", "--help"]),
    ]);
    if (!versionResult || !stdioHelpResult) {
      continue;
    }
    if (!/Run the agent over stdio/i.test(resultText(stdioHelpResult))) {
      continue;
    }
    const now = options?.now?.() ?? Date.now();
    const backendId = "acp:grok" as AcpBackendId;
    const version = parseCliVersion(resultText(versionResult));
    return {
      backendId,
      registryId: "grok",
      name: "Grok",
      version,
      distributionKind: "local",
      distributionSource: `${command} agent stdio`,
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: "local-grok-cli",
      installedAt: now,
      updatedAt: now,
      capabilities: acpAgentCapabilitiesForRegistryId("grok"),
      launchDescriptor: normalizeAcpLaunchDescriptor({
        backendId,
        registryId: "grok",
        distributionKind: "local",
        command,
        args: ["agent", "stdio"],
        env: {},
      }),
      registryAgent: {
        id: "grok",
        backendId,
        name: "Grok",
        version,
        authors: ["xAI"],
        distributions: [],
        distributionKinds: ["local"],
        auth: { required: false, methods: ["agent-managed"] },
        raw: { source: "local-cli" },
      },
    };
  }
  return undefined;
}

async function discoverLocalQwen(
  options?: LocalAcpDiscoveryOptions,
): Promise<AcpInstalledAgentRecord | undefined> {
  const probe = options?.probe ?? defaultProbe;
  const candidates = qwenCandidatePaths(options?.overrides?.qwen);
  for (const command of candidates) {
    const [versionResult, helpResult] = await Promise.all([
      probeCommand(probe, command, ["--version"]),
      probeCommand(probe, command, ["--help"]),
    ]);
    if (!versionResult || !helpResult) {
      continue;
    }
    if (!/(^|\s)--acp(\s|,|$)/.test(resultText(helpResult))) {
      continue;
    }
    const now = options?.now?.() ?? Date.now();
    const backendId = "acp:qwen" as AcpBackendId;
    const version = parseCliVersion(resultText(versionResult));
    return {
      backendId,
      registryId: "qwen",
      name: "Qwen Code",
      version,
      distributionKind: "local",
      distributionSource: `${command} --acp`,
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: "local-qwen-code-cli",
      installedAt: now,
      updatedAt: now,
      capabilities: acpAgentCapabilitiesForRegistryId("qwen"),
      launchDescriptor: normalizeAcpLaunchDescriptor({
        backendId,
        registryId: "qwen",
        distributionKind: "local",
        command,
        args: ["--acp"],
        env: {},
      }),
      registryAgent: {
        id: "qwen",
        backendId,
        name: "Qwen Code",
        version,
        authors: ["Qwen Team"],
        license: "Apache-2.0",
        repositoryUrl: "https://github.com/QwenLM/qwen-code",
        distributions: [],
        distributionKinds: ["local"],
        auth: { required: false, methods: ["agent-managed"] },
        raw: { source: "local-cli" },
      },
    };
  }
  return undefined;
}

/**
 * Build the ordered list of Grok CLI candidate paths to probe.
 *
 * The override (Settings → ACP Agents → "Grok CLI path", or the
 * `PWRAGENT_ACP_AGENTS_GROK_CLI_PATH` env var) is checked first, then
 * `$PATH`, then the official-installer location, then the standard
 * Homebrew prefixes.
 *
 * **Trust model.** The override is passed verbatim to {@link execFile}
 * (no shell), so shell metacharacters cannot escape the process
 * boundary — but the path *is* the binary that gets run. Anyone who
 * can write to `~/.pwragent/profiles/<name>/config.toml` or set the
 * env var in this process's environment can pick which executable
 * runs on every discovery refresh. This matches Codex's `command` and
 * Gemini/Kimi's launch-descriptor trust model: the user (or anyone
 * with write access to their per-profile config) is implicitly
 * trusted. We do NOT validate that the override is a "real" grok
 * binary beyond the `--help` probe in {@link discoverLocalGrok},
 * which only confirms the binary advertises the expected ACP stdio
 * subcommand.
 */
function grokCandidatePaths(override?: string): string[] {
  const candidates: string[] = [];
  if (override && override.trim().length > 0) {
    candidates.push(override.trim());
  }
  candidates.push("grok");
  candidates.push(path.join(homedir(), ".grok", "bin", "grok"));
  candidates.push("/opt/homebrew/bin/grok");
  candidates.push("/usr/local/bin/grok");
  return Array.from(new Set(candidates));
}

function qwenCandidatePaths(override?: string): string[] {
  const candidates: string[] = [];
  if (override && override.trim().length > 0) {
    candidates.push(override.trim());
  }
  candidates.push("qwen");
  candidates.push(path.join(homedir(), ".qwen", "bin", "qwen"));
  candidates.push("/opt/homebrew/bin/qwen");
  candidates.push("/usr/local/bin/qwen");
  return Array.from(new Set(candidates));
}

/**
 * Build the ordered list of Kimi Code CLI candidate paths to probe.
 *
 * Kimi Code's official installer drops the binary at
 * `~/.kimi-code/bin/kimi` and appends that directory to the user's shell
 * PATH. GUI-launched apps don't always inherit that interactive PATH, so —
 * mirroring {@link grokCandidatePaths} / {@link qwenCandidatePaths} — we
 * probe the bare `kimi` command first (fast path when it IS on PATH), then
 * the installer's default location, then the standard Homebrew prefixes.
 * The same trust model documented on {@link grokCandidatePaths} applies.
 */
function kimiCandidatePaths(override?: string): string[] {
  const candidates: string[] = [];
  if (override && override.trim().length > 0) {
    candidates.push(override.trim());
  }
  candidates.push("kimi");
  candidates.push(path.join(homedir(), ".kimi-code", "bin", "kimi"));
  candidates.push("/opt/homebrew/bin/kimi");
  candidates.push("/usr/local/bin/kimi");
  return Array.from(new Set(candidates));
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
  return parseCliVersion(output);
}

function parseCliVersion(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? trimmed;
}
