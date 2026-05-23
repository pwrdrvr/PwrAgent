import type {
  AcpBackendId,
  BackendAcpAuthStatus,
  BackendAcpDistributionKind,
  BackendAcpInstallStatus,
  BackendAcpRuntimeCapabilities,
  BackendAcpVerificationStatus,
} from "@pwragent/shared";
import type { AcpLaunchDescriptor } from "./acp-launch-descriptor.js";
import type { AcpAgentCapabilities } from "./acp-agent-capabilities.js";

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export type AcpRegistryDistributionEnv = Record<string, string>;

export type AcpPackageDistribution = {
  kind: "npx" | "uvx";
  packageName: string;
  args: string[];
  env: AcpRegistryDistributionEnv;
};

export type AcpBinaryPlatformDistribution = {
  kind: "binary";
  platform: string;
  archiveUrl: string;
  command: string;
  args: string[];
  env: AcpRegistryDistributionEnv;
  checksum?: string;
  signatureUrl?: string;
};

export type AcpRegistryDistribution =
  | AcpPackageDistribution
  | AcpBinaryPlatformDistribution;

export type AcpRegistryAuthMethod =
  | "agent-managed"
  | "terminal"
  | "unknown";

export type AcpRegistryAuthDescriptor = {
  required: boolean;
  methods: AcpRegistryAuthMethod[];
  raw?: unknown;
};

export type AcpRegistryAgent = {
  id: string;
  backendId: AcpBackendId;
  name: string;
  version?: string;
  description?: string;
  authors: string[];
  license?: string;
  repositoryUrl?: string;
  websiteUrl?: string;
  iconUrl?: string;
  distributions: AcpRegistryDistribution[];
  distributionKinds: BackendAcpDistributionKind[];
  auth: AcpRegistryAuthDescriptor;
  raw: unknown;
};

export type AcpAllowlistDecision =
  | {
      allowed: true;
      ruleId: string;
      unverifiedBinaryAllowed: boolean;
    }
  | {
      allowed: false;
      reason: string;
    };

export type AcpRegistryAgentWithPolicy = AcpRegistryAgent & {
  allowlist: AcpAllowlistDecision;
  installable: boolean;
  unavailableReason?: string;
  verificationStatus: BackendAcpVerificationStatus;
};

export type AcpRegistrySnapshot = {
  fetchedAt: number;
  agents: AcpRegistryAgent[];
  raw: unknown;
};

export type AcpInstalledAgentRecord = {
  backendId: AcpBackendId;
  registryId: string;
  name: string;
  version?: string;
  distributionKind: BackendAcpDistributionKind;
  distributionSource: string;
  installStatus: BackendAcpInstallStatus;
  authStatus: BackendAcpAuthStatus;
  verificationStatus: BackendAcpVerificationStatus;
  allowlistRuleId: string;
  installedAt: number;
  updatedAt: number;
  launchDescriptor?: AcpLaunchDescriptor;
  capabilities?: AcpAgentCapabilities;
  runtimeCapabilities?: BackendAcpRuntimeCapabilities;
  lastDiscoveredAt?: number;
  lastDiscoveryError?: string;
  lastError?: string;
  registryAgent?: AcpRegistryAgent;
};
