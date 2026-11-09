import type { FederationStorage } from "@pwragent/shared";
import { getAppStateDb } from "../state/app-state";
import { FederationStore } from "./federation-store";
import { SqliteDurableTurnRequestStore } from "./durable-turn-request-store";
import type { DurableTurnRequestStorage } from "@pwragent/owner-core/durable-turn-request-storage";

const fields = {
  instanceId: "federation_instance_id",
  gatewayInstanceId: "federation_gateway_instance_id",
  gatewayPublicKey: "federation_gateway_public_key_pem",
  gatewayNoisePublicKey: "federation_gateway_noise_public_key",
  // Legacy preference: only cleared when changing pairings; never used for ordering.
  gatewayLastEndpoint: "federation_gateway_last_endpoint",
  pendingInviteToken: "federation_pending_invite_token",
  gatewayEnrolledAt: "federation_gateway_enrolled_at",
  celestialIconAssignments: "federation_celestial_icon_assignments",
  shortNames: "federation_instance_short_names",
  profileName: "profile_name",
} as const;

/** Only federation-owned settings are available here, with each original write
 * left independent. Pairing and reset do not acquire a new transaction. */
export const desktopFederationState = {
  read(field: keyof typeof fields): string | undefined {
    return getAppStateDb().getMeta(fields[field]);
  },
  write(field: keyof typeof fields, value: string): void {
    getAppStateDb().setMeta(fields[field], value);
  },
};

export type { FederationStorage } from "@pwragent/shared";
export function createFederationStorage(): FederationStorage {
  return new FederationStore(getAppStateDb());
}
export function createDurableTurnRequestStorage(): DurableTurnRequestStorage {
  return new SqliteDurableTurnRequestStore(getAppStateDb());
}
