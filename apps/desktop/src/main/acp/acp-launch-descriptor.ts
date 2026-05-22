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
  if (descriptor.registryId !== "gemini") {
    return descriptor;
  }

  if (!descriptor.args.includes("--acp") || descriptor.args.includes("--skip-trust")) {
    return descriptor;
  }

  return {
    ...descriptor,
    args: [...descriptor.args, "--skip-trust"],
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
