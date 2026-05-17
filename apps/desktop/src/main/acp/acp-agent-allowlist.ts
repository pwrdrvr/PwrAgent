import type { BackendAcpDistributionKind } from "@pwragent/shared";
import type {
  AcpAllowlistDecision,
  AcpRegistryAgent,
  AcpRegistryDistribution,
} from "./acp-registry-types.js";

export type AcpAgentAllowlistRule = {
  id: string;
  registryId: string;
  versions?: string[];
  distributionKinds?: BackendAcpDistributionKind[];
  allowedPackageNames?: string[];
  allowedArchiveHosts?: string[];
  allowUnverifiedBinary?: boolean;
  allowGplFamilyLicense?: boolean;
};

export const DEFAULT_ACP_AGENT_ALLOWLIST: AcpAgentAllowlistRule[] = [
  {
    id: "codex-acp-v0.14.0",
    registryId: "codex-acp",
    versions: ["0.14.0"],
    distributionKinds: ["npx", "binary"],
    allowedPackageNames: ["@zed-industries/codex-acp@0.14.0"],
    allowedArchiveHosts: ["github.com"],
    allowUnverifiedBinary: true,
  },
  {
    id: "gemini-npx",
    registryId: "gemini",
    distributionKinds: ["npx"],
    allowedPackageNames: ["@google/gemini-cli"],
  },
];

export class AcpAgentAllowlist {
  constructor(private readonly rules: AcpAgentAllowlistRule[]) {}

  evaluate(agent: AcpRegistryAgent): AcpAllowlistDecision {
    const matchingRules = this.rules.filter((rule) => rule.registryId === agent.id);
    if (matchingRules.length === 0) {
      return { allowed: false, reason: "not-allowlisted" };
    }

    for (const rule of matchingRules) {
      const denial = evaluateRule(rule, agent);
      if (!denial) {
        return {
          allowed: true,
          ruleId: rule.id,
          unverifiedBinaryAllowed: rule.allowUnverifiedBinary === true,
        };
      }
    }

    return { allowed: false, reason: "allowlist-rule-mismatch" };
  }
}

export const defaultAcpAgentAllowlist = new AcpAgentAllowlist(
  DEFAULT_ACP_AGENT_ALLOWLIST,
);

function evaluateRule(
  rule: AcpAgentAllowlistRule,
  agent: AcpRegistryAgent,
): string | undefined {
  if (rule.versions && (!agent.version || !rule.versions.includes(agent.version))) {
    return "version-not-allowed";
  }

  if (isGplFamilyLicense(agent.license) && !rule.allowGplFamilyLicense) {
    return "license-not-allowed";
  }

  const distributions = agent.distributions.filter((distribution) =>
    distributionAllowedByKind(rule, distribution),
  );
  if (distributions.length === 0) {
    return "distribution-not-allowed";
  }

  if (!distributions.some((distribution) => distributionSourceAllowed(rule, distribution))) {
    return "distribution-source-not-allowed";
  }

  return undefined;
}

function distributionAllowedByKind(
  rule: AcpAgentAllowlistRule,
  distribution: AcpRegistryDistribution,
): boolean {
  return (
    !rule.distributionKinds ||
    rule.distributionKinds.includes(distribution.kind)
  );
}

function distributionSourceAllowed(
  rule: AcpAgentAllowlistRule,
  distribution: AcpRegistryDistribution,
): boolean {
  if (distribution.kind === "npx" || distribution.kind === "uvx") {
    return (
      !rule.allowedPackageNames ||
      rule.allowedPackageNames.includes(distribution.packageName)
    );
  }

  if (distribution.kind !== "binary") {
    return false;
  }

  if (!rule.allowedArchiveHosts) {
    return true;
  }

  try {
    return rule.allowedArchiveHosts.includes(new URL(distribution.archiveUrl).host);
  } catch {
    return false;
  }
}

function isGplFamilyLicense(license: string | undefined): boolean {
  return /\b(?:GPL|AGPL|LGPL)\b/i.test(license ?? "");
}
