import type { ConfigSnapshotStorage, DurableConfigSnapshot as Snapshot } from "@pwragent/owner-core/config-snapshot-storage";
import type { ConfigDomainMap, ProviderId, ProviderProjection } from "./config-domains";

export type DurableConfigSnapshot = Snapshot<ConfigDomainMap>;
export type DesktopConfigSnapshotStorage = ConfigSnapshotStorage<ConfigDomainMap, ProviderId, ProviderProjection>;
