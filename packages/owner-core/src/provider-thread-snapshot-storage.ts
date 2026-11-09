import type {
  AppServerBackendKind,
  AppServerThreadSummary,
} from "@pwragent/shared";

export type ProviderThreadSnapshot = Readonly<{
  backend: AppServerBackendKind;
  observedAt: number;
  threads: readonly AppServerThreadSummary[];
}>;

export interface ProviderThreadSnapshotStorage {
  list(): ProviderThreadSnapshot[];
  replace(snapshot: ProviderThreadSnapshot): void;
}

