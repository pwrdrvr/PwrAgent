/** Durable host configuration and provider discoveries; reads never write. */
export type DurableConfigSnapshot<Domains> = Readonly<{
  configRevision: string;
  contentHash: string;
  domains: Domains;
  schemaVersion: number;
  updatedAt: number;
}>;

/** The host binds its domain types and retains its existing SQL lifecycle. */
export interface ConfigSnapshotStorage<Domains, ProviderId extends string, Provider> {
  readConfig(): DurableConfigSnapshot<Domains> | undefined;
  writeConfig(snapshot: DurableConfigSnapshot<Domains>): void;
  readProviders(): Partial<Record<ProviderId, Provider>>;
  writeProvider(projection: Provider): void;
}
