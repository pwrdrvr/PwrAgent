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

const BANNED_ACP_REGISTRY_IDS = new Set(["codex-acp"]);

/**
 * The `local-grok-cli` rule is **decorative for the local-discovery path**
 * (mirroring how Gemini and Kimi are surfaced today). Locally-discovered
 * agents are installed by the user out-of-band — `discoverLocalAcpAgents`
 * probes the binary, builds an `AcpInstalledAgentRecord` with
 * `distributionKind: "local"`, and surfaces it to the renderer without
 * routing through {@link AcpAgentAllowlist.evaluate}. The allowlist's
 * `distributionSourceAllowed` helper also rejects any kind outside
 * `npx | uvx | binary`, so even if a registry payload for "grok" arrived
 * tomorrow with `distributionKinds: ["local"]`, it would be denied at
 * the source check.
 *
 * The rule is retained for:
 *   1. Symmetry with the Kimi/Gemini precedent (their installed-agent
 *      records carry `allowlistRuleId: "local-<id>-cli"`).
 *   2. Forward-compat for a future registry distribution of the Grok
 *      CLI — at that point this rule expands with `distributionKinds:
 *      ["binary", "npx", ...]` plus archive-host / package-name
 *      pinning.
 */
export const DEFAULT_ACP_AGENT_ALLOWLIST: AcpAgentAllowlistRule[] = [
  {
    id: "local-grok-cli",
    registryId: "grok",
    distributionKinds: ["local"],
  },
];

export class AcpAgentAllowlist {
  constructor(private readonly rules: AcpAgentAllowlistRule[]) {}

  evaluate(agent: AcpRegistryAgent): AcpAllowlistDecision {
    if (isBannedAcpRegistryId(agent.id)) {
      return { allowed: false, reason: "banned" };
    }

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

  evaluateDistribution(
    agent: AcpRegistryAgent,
    distribution: AcpRegistryDistribution,
  ): AcpAllowlistDecision {
    if (isBannedAcpRegistryId(agent.id)) {
      return { allowed: false, reason: "banned" };
    }

    const matchingRules = this.rules.filter((rule) => rule.registryId === agent.id);
    if (matchingRules.length === 0) {
      return { allowed: false, reason: "not-allowlisted" };
    }

    for (const rule of matchingRules) {
      const denial = evaluateDistributionRule(rule, agent, distribution);
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

export function isBannedAcpRegistryId(registryId: string): boolean {
  // PwrAgent talks to Codex through the first-class Codex App Server backend.
  // The ACP adapter should not be presented as an installable duplicate.
  return BANNED_ACP_REGISTRY_IDS.has(registryId);
}

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

  let distributionDeniedBySource = false;
  for (const distribution of agent.distributions) {
    const denial = evaluateDistributionRule(rule, agent, distribution, {
      skipAgentChecks: true,
    });
    if (!denial) {
      return undefined;
    }
    if (denial === "distribution-source-not-allowed") {
      distributionDeniedBySource = true;
    }
  }

  return distributionDeniedBySource
    ? "distribution-source-not-allowed"
    : "distribution-not-allowed";
}

function evaluateDistributionRule(
  rule: AcpAgentAllowlistRule,
  agent: AcpRegistryAgent,
  distribution: AcpRegistryDistribution,
  options: { skipAgentChecks?: boolean } = {},
): string | undefined {
  if (
    !options.skipAgentChecks &&
    rule.versions &&
    (!agent.version || !rule.versions.includes(agent.version))
  ) {
    return "version-not-allowed";
  }

  if (
    !options.skipAgentChecks &&
    isGplFamilyLicense(agent.license) &&
    !rule.allowGplFamilyLicense
  ) {
    return "license-not-allowed";
  }

  if (!distributionAllowedByKind(rule, distribution)) {
    return "distribution-not-allowed";
  }

  if (!distributionSourceAllowed(rule, distribution)) {
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
