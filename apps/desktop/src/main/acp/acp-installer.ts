import type { BackendAcpAuthStatus } from "@pwragent/shared";
import type { AcpAgentStore } from "./acp-agent-store.js";
import {
  installAcpBinary,
  type AcpArchiveDownloader,
  type AcpArchiveExtractor,
} from "./acp-binary-installer.js";
import { describeDistributionSource } from "./acp-install-provenance.js";
import { prepareAcpPackageLaunch } from "./acp-package-installer.js";
import type { AcpPrerequisiteProbe } from "./acp-prerequisites.js";
import type {
  AcpInstalledAgentRecord,
  AcpRegistryAgent,
  AcpRegistryDistribution,
} from "./acp-registry-types.js";

export type AcpInstallRequest = {
  agent: AcpRegistryAgent;
  distribution: AcpRegistryDistribution;
  allowlistRuleId: string;
  installRoot: string;
  confirmed: boolean;
};

export type AcpInstallResult =
  | { ok: true; record: AcpInstalledAgentRecord }
  | { ok: false; record: AcpInstalledAgentRecord };

export class AcpInstaller {
  constructor(
    private readonly options: {
      store: AcpAgentStore;
      now?: () => number;
      prerequisiteProbe?: AcpPrerequisiteProbe;
      archiveDownloader?: AcpArchiveDownloader;
      archiveExtractor?: AcpArchiveExtractor;
    },
  ) {}

  async install(request: AcpInstallRequest): Promise<AcpInstallResult> {
    const now = this.options.now?.() ?? Date.now();
    const baseRecord = buildBaseRecord(request, now);
    if (!request.confirmed) {
      const record: AcpInstalledAgentRecord = {
        ...baseRecord,
        installStatus: "install-failed",
        lastError: "install-not-confirmed",
      };
      this.options.store.upsertInstalledAgent(record);
      return { ok: false, record };
    }

    const installResult =
      request.distribution.kind === "binary"
        ? await installAcpBinary({
            agent: request.agent,
            distribution: request.distribution,
            installRoot: request.installRoot,
            downloader: this.options.archiveDownloader,
            extractor: this.options.archiveExtractor,
          })
        : await prepareAcpPackageLaunch({
            agent: request.agent,
            distribution: request.distribution,
            probe: this.options.prerequisiteProbe,
          });

    const record: AcpInstalledAgentRecord = installResult.ok
      ? {
          ...baseRecord,
          installStatus: "installed",
          launchDescriptor: installResult.launchDescriptor,
          ...(installResult.launchDescriptor.distributionKind === "binary"
            ? { verificationStatus: baseRecord.verificationStatus }
            : {}),
        }
      : {
          ...baseRecord,
          installStatus: "install-failed",
          lastError: installResult.unavailableReason,
        };

    this.options.store.upsertInstalledAgent(record);
    return installResult.ok ? { ok: true, record } : { ok: false, record };
  }
}

function buildBaseRecord(
  request: AcpInstallRequest,
  now: number,
): AcpInstalledAgentRecord {
  return {
    backendId: request.agent.backendId,
    registryId: request.agent.id,
    name: request.agent.name,
    version: request.agent.version,
    distributionKind: request.distribution.kind,
    distributionSource: describeDistributionSource(request.distribution),
    installStatus: "installing",
    authStatus: authStatusForAgent(request.agent),
    verificationStatus:
      request.distribution.kind === "binary" &&
      !request.distribution.checksum
        ? "unverified-allowed"
        : request.distribution.kind === "binary"
          ? "verified"
          : "not-applicable",
    allowlistRuleId: request.allowlistRuleId,
    installedAt: now,
    updatedAt: now,
    registryAgent: request.agent,
  };
}

function authStatusForAgent(agent: AcpRegistryAgent): BackendAcpAuthStatus {
  return agent.auth.required ? "required" : "not-required";
}
