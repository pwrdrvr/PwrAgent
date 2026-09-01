import type { StateDb } from "../../state/state-db";
import {
  CONFIG_STORE_DURABLE_SCHEMA_VERSION,
  PROVIDER_IDS,
  deepFreeze,
  type ConfigDomainMap,
  type ProviderId,
  type ProviderProjection,
} from "./config-domains";

const CONFIG_SNAPSHOT_KEY = "latest";

export type DurableConfigSnapshot = Readonly<{
  configRevision: string;
  contentHash: string;
  domains: ConfigDomainMap;
  schemaVersion: number;
  updatedAt: number;
}>;

export class DurableConfigSnapshotStore {
  constructor(private readonly stateDb: StateDb) {}

  readConfig(): DurableConfigSnapshot | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT schema_version, config_revision, content_hash, updated_at, payload
         FROM desktop_config_snapshots
         WHERE snapshot_key = ?`,
      )
      .get(CONFIG_SNAPSHOT_KEY) as {
        schema_version: number;
        config_revision: string;
        content_hash: string;
        updated_at: number;
        payload: string;
      } | undefined;
    if (!row || row.schema_version !== CONFIG_STORE_DURABLE_SCHEMA_VERSION) {
      return undefined;
    }
    const domains = parseConfigDomains(row.payload);
    if (!domains) {
      return undefined;
    }
    return deepFreeze({
      configRevision: row.config_revision,
      contentHash: row.content_hash,
      domains,
      schemaVersion: row.schema_version,
      updatedAt: row.updated_at,
    });
  }

  writeConfig(snapshot: DurableConfigSnapshot): void {
    this.stateDb.raw
      .prepare(
        `INSERT INTO desktop_config_snapshots(
           snapshot_key,
           schema_version,
           config_revision,
           content_hash,
           updated_at,
           payload
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(snapshot_key) DO UPDATE SET
           schema_version = excluded.schema_version,
           config_revision = excluded.config_revision,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at,
           payload = excluded.payload`,
      )
      .run(
        CONFIG_SNAPSHOT_KEY,
        snapshot.schemaVersion,
        snapshot.configRevision,
        snapshot.contentHash,
        snapshot.updatedAt,
        JSON.stringify(snapshot.domains),
      );
  }

  readProviders(): Partial<Record<ProviderId, ProviderProjection>> {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT provider_id, schema_version, payload
         FROM provider_discovery_snapshots`,
      )
      .all() as Array<{
        provider_id: string;
        schema_version: number;
        payload: string;
      }>;
    const providers: Partial<Record<ProviderId, ProviderProjection>> = {};
    for (const row of rows) {
      if (row.schema_version !== CONFIG_STORE_DURABLE_SCHEMA_VERSION) {
        continue;
      }
      const provider = parseProviderProjection(row.payload);
      if (provider && provider.provider === row.provider_id) {
        providers[provider.provider] = provider;
      }
    }
    return deepFreeze(providers);
  }

  writeProvider(projection: ProviderProjection): void {
    const validatedAt = projection.lastKnownGood?.validatedAt;
    if (validatedAt === undefined) {
      return;
    }
    this.stateDb.raw
      .prepare(
        `INSERT INTO provider_discovery_snapshots(
           provider_id,
           schema_version,
           dependency_fingerprint,
           validated_at,
           payload
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           dependency_fingerprint = excluded.dependency_fingerprint,
           validated_at = excluded.validated_at,
           payload = excluded.payload`,
      )
      .run(
        projection.provider,
        CONFIG_STORE_DURABLE_SCHEMA_VERSION,
        projection.dependencyFingerprint,
        validatedAt,
        JSON.stringify(projection),
      );
  }
}

function parseConfigDomains(payload: string): ConfigDomainMap | undefined {
  const parsed = parseJson(payload);
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (
    !isRecord(parsed.general)
    || !isRecord(parsed.onboarding)
    || !isRecord(parsed.providers)
    || !isRecord(parsed.experimental)
    || !isRecord(parsed.messaging)
    || !isRecord(parsed.federation)
    || !isRecord(parsed.models)
    || !isRecord(parsed.applications)
    || !isRecord(parsed.git)
    || !isRecord(parsed.updates)
    || !isRecord(parsed.worktrees)
    || !isRecord(parsed.ui)
    || !isRecord(parsed.integratedTerminal)
    || !isRecord(parsed.imageUploads)
    || !isRecord(parsed.general.appearance)
    || !isRecord(parsed.general.settings)
    || typeof parsed.onboarding.completed !== "boolean"
    || typeof parsed.onboarding.completedSource !== "string"
  ) {
    return undefined;
  }
  for (const provider of PROVIDER_IDS) {
    if (!parseProviderProjectionValue(parsed.providers[provider])) {
      return undefined;
    }
  }
  return deepFreeze(parsed as ConfigDomainMap);
}

function parseProviderProjection(payload: string): ProviderProjection | undefined {
  return parseProviderProjectionValue(parseJson(payload));
}

function parseProviderProjectionValue(value: unknown): ProviderProjection | undefined {
  if (!isRecord(value) || !PROVIDER_IDS.includes(value.provider as ProviderId)) {
    return undefined;
  }
  if (
    typeof value.dependencyFingerprint !== "string"
    || !isRecord(value.configured)
    || typeof value.configured.enabled !== "boolean"
    || !isRecord(value.validation)
    || typeof value.validation.state !== "string"
  ) {
    return undefined;
  }
  return deepFreeze(value as ProviderProjection);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
