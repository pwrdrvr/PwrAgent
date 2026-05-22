import type { AcpBackendId, BackendAcpDistributionKind } from "@pwragent/shared";

export type AcpLaunchDescriptor = {
  backendId: AcpBackendId;
  registryId: string;
  distributionKind: BackendAcpDistributionKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  installPath?: string;
};

export function normalizeAcpLaunchDescriptor(
  descriptor: AcpLaunchDescriptor,
): AcpLaunchDescriptor {
  if (descriptor.registryId !== "gemini" || !descriptor.args.includes("--acp")) {
    return descriptor;
  }

  const args = descriptor.args.includes("--skip-trust")
    ? descriptor.args
    : [...descriptor.args, "--skip-trust"];
  return {
    ...descriptor,
    args,
    env: {
      ...descriptor.env,
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    },
  };
}

export function buildPackageLaunchDescriptor(params: {
  backendId: AcpBackendId;
  registryId: string;
  kind: "npx" | "uvx";
  packageName: string;
  args: string[];
  env: Record<string, string>;
}): AcpLaunchDescriptor {
  return normalizeAcpLaunchDescriptor({
    backendId: params.backendId,
    registryId: params.registryId,
    distributionKind: params.kind,
    command: params.kind,
    args:
      params.kind === "npx"
        ? ["--yes", params.packageName, ...params.args]
        : [params.packageName, ...params.args],
    env: params.env,
  });
}

export function buildBinaryLaunchDescriptor(params: {
  backendId: AcpBackendId;
  registryId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  installPath: string;
}): AcpLaunchDescriptor {
  return normalizeAcpLaunchDescriptor({
    backendId: params.backendId,
    registryId: params.registryId,
    distributionKind: "binary",
    command: params.command,
    args: params.args,
    env: params.env,
    installPath: params.installPath,
  });
}
