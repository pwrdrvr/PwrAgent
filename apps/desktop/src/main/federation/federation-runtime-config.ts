import {
  DESKTOP_FEDERATION_MODE_DEFAULT,
  type DesktopFederationMode,
} from "@pwragent/shared";
import type { ConfigDomainMap } from "../settings/config-store/config-domains";

export type FederationRuntimeConfig = Readonly<{
  advertisedEndpoints: readonly string[];
  cloudflareAccessServiceAuthEnabled: boolean;
  cloudflareEndpoint: string;
  cloudflareMtlsEnabled: boolean;
  gatewayEndpoints: readonly string[];
  instanceLabel: string;
  instanceNotes: string;
  listenHost: string;
  listenPort: number;
  mode: DesktopFederationMode;
  publicUrl: string;
}>;

export function resolveFederationRuntimeConfig(
  config: ConfigDomainMap["federation"],
): FederationRuntimeConfig {
  return Object.freeze({
    advertisedEndpoints: Object.freeze(normalizeEndpoints(
      config.advertisedEndpoints,
    )),
    cloudflareAccessServiceAuthEnabled:
      config.cloudflareAccessServiceAuthEnabled ?? false,
    cloudflareEndpoint: config.cloudflareEndpoint?.trim() ?? "",
    cloudflareMtlsEnabled: config.cloudflareMtlsEnabled ?? false,
    gatewayEndpoints: Object.freeze(normalizeEndpoints(
      config.gatewayEndpoints,
      config.gatewayUrl,
    )),
    instanceLabel: config.instanceLabel?.trim() ?? "",
    instanceNotes: config.instanceNotes?.trim() ?? "",
    listenHost: config.listenHost ?? "127.0.0.1",
    listenPort: config.listenPort ?? 47_830,
    mode: config.mode ?? DESKTOP_FEDERATION_MODE_DEFAULT,
    publicUrl: config.publicUrl?.trim() ?? "",
  });
}

function normalizeEndpoints(
  configured: readonly string[] | undefined,
  fallback?: string,
): string[] {
  const endpoints = configured
    ?.map((endpoint) => endpoint.trim())
    .filter((endpoint) => endpoint.length > 0);
  if (endpoints && endpoints.length > 0) {
    return endpoints;
  }
  const fallbackEndpoint = fallback?.trim();
  return fallbackEndpoint ? [fallbackEndpoint] : [];
}
