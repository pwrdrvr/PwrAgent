import {
  buildPackageLaunchDescriptor,
  type AcpLaunchDescriptor,
} from "./acp-launch-descriptor.js";
import {
  checkAcpPrerequisite,
  type AcpPrerequisiteProbe,
} from "./acp-prerequisites.js";
import type {
  AcpPackageDistribution,
  AcpRegistryAgent,
} from "./acp-registry-types.js";

export type AcpPackageInstallResult =
  | {
      ok: true;
      launchDescriptor: AcpLaunchDescriptor;
      prerequisiteVersion?: string;
    }
  | {
      ok: false;
      unavailableReason: string;
    };

export async function prepareAcpPackageLaunch(params: {
  agent: AcpRegistryAgent;
  distribution: AcpPackageDistribution;
  probe?: AcpPrerequisiteProbe;
}): Promise<AcpPackageInstallResult> {
  const prerequisite = await checkAcpPrerequisite(params.distribution.kind, {
    probe: params.probe,
  });
  if (!prerequisite.available) {
    return {
      ok: false,
      unavailableReason: `${params.distribution.kind}-missing:${prerequisite.unavailableReason}`,
    };
  }

  return {
    ok: true,
    prerequisiteVersion: prerequisite.version,
    launchDescriptor: buildPackageLaunchDescriptor({
      backendId: params.agent.backendId,
      registryId: params.agent.id,
      kind: params.distribution.kind,
      packageName: params.distribution.packageName,
      args: params.distribution.args,
      env: params.distribution.env,
    }),
  };
}
