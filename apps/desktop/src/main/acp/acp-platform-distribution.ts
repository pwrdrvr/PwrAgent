import type {
  AcpBinaryPlatformDistribution,
  AcpRegistryDistribution,
} from "./acp-registry-types.js";

export function selectAcpDistributionForCurrentPlatform(
  distributions: AcpRegistryDistribution[],
  preferredKind?: AcpRegistryDistribution["kind"],
): AcpRegistryDistribution | undefined {
  return selectAcpDistributionForPlatform(
    distributions,
    currentAcpPlatformNames(),
    preferredKind,
  );
}

export function selectAcpDistributionForPlatform(
  distributions: AcpRegistryDistribution[],
  platformNames: readonly string[],
  preferredKind?: AcpRegistryDistribution["kind"],
): AcpRegistryDistribution | undefined {
  const candidates = preferredKind
    ? distributions.filter((distribution) => distribution.kind === preferredKind)
    : distributions;
  return (
    candidates.find((distribution) => distribution.kind === "npx") ??
    candidates.find((distribution) => distribution.kind === "uvx") ??
    candidates.find(
      (distribution): distribution is AcpBinaryPlatformDistribution =>
        distribution.kind === "binary" &&
        platformNames.includes(normalizePlatformName(distribution.platform)),
    )
  );
}

export function currentAcpPlatformNames(): string[] {
  const osNames = platformOsNames(process.platform);
  const archNames = platformArchNames(process.arch);
  return osNames.flatMap((osName) => [
    ...archNames.map((archName) => `${osName}-${archName}`),
    osName,
  ]);
}

function platformOsNames(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case "darwin":
      return ["darwin", "macos"];
    case "linux":
      return ["linux"];
    case "win32":
      return ["windows", "win32"];
    default:
      return [platform];
  }
}

function platformArchNames(arch: string): string[] {
  switch (arch) {
    case "x64":
      return ["x64", "amd64"];
    case "arm64":
      return ["arm64", "aarch64"];
    default:
      return [arch];
  }
}

function normalizePlatformName(platform: string): string {
  return platform.trim().toLowerCase();
}
