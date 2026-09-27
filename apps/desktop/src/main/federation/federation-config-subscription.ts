import { isDeepStrictEqual } from "node:util";
import type { DesktopSettingsConfigPatch } from "@pwragent/shared";
import type { DesktopConfigStore } from "../settings/config-store/desktop-config-store";

type Runtime = {
  restart: () => Promise<void>;
  applyCloudflareGatewaySetting: () => Promise<void>;
};

export function applyFederationConfigPatch(
  runtime: Runtime,
  patch: NonNullable<DesktopSettingsConfigPatch["federation"]>,
): Promise<void> {
  return Object.keys(patch).some((key) => key !== "cloudflareGatewayEnabled")
    ? runtime.restart()
    : runtime.applyCloudflareGatewaySetting();
}

export function subscribeFederationConfig(
  store: DesktopConfigStore,
  runtime: Runtime,
  onError: (error: unknown) => void,
): () => void {
  let previous = store.read("federation");
  return store.subscribe(["federation"], ({ values }) => {
    const { cloudflareGatewayEnabled: beforeEnabled, ...before } = previous;
    const { cloudflareGatewayEnabled: afterEnabled, ...after } = values.federation;
    previous = values.federation;
    // Restarting destroys every peer's remote terminals. Only changes outside
    // the live Cloudflare ingress switch require rebuilding the runtime.
    if (!isDeepStrictEqual(before, after)) {
      void runtime.restart().catch(onError);
    } else if ((beforeEnabled !== false) !== (afterEnabled !== false)) {
      void runtime.applyCloudflareGatewaySetting().catch(onError);
    }
  });
}
