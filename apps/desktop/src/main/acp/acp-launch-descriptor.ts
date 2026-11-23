import type { AcpBackendId } from "@pwragent/shared/contracts/normalized-app-server";
import type { BackendAcpDistributionKind } from "@pwragent/shared/contracts/backend";

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

export function acpAgentLaunchIdentity(agent: {
  activeCommand?: string;
  launchDescriptor?: AcpLaunchDescriptor;
}): string {
  const descriptor = agent.launchDescriptor;
  return JSON.stringify({
    activeCommand: agent.activeCommand,
    launchDescriptor: descriptor
      ? {
          backendId: descriptor.backendId,
          registryId: descriptor.registryId,
          distributionKind: descriptor.distributionKind,
          command: descriptor.command,
          args: descriptor.args,
          env: Object.fromEntries(Object.entries(descriptor.env).sort()),
          cwd: descriptor.cwd,
          installPath: descriptor.installPath,
        }
      : undefined,
  });
}

export function normalizeAcpLaunchDescriptor(
  descriptor: AcpLaunchDescriptor,
): AcpLaunchDescriptor {
  const normalizedDescriptor =
    descriptor.registryId === "grok"
      ? {
          ...descriptor,
          env: {
            ...descriptor.env,
            NO_COLOR: "1",
          },
        }
      : descriptor;

  if (
    normalizedDescriptor.registryId !== "gemini"
    || !normalizedDescriptor.args.includes("--acp")
  ) {
    return normalizedDescriptor;
  }

  const args = normalizedDescriptor.args.includes("--skip-trust")
    ? normalizedDescriptor.args
    : [...normalizedDescriptor.args, "--skip-trust"];
  return {
    ...normalizedDescriptor,
    args,
    env: {
      ...normalizedDescriptor.env,
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
