import type { AcpAgentStorage } from "@pwragent/owner-core/acp-storage";
import type { AcpBackendId } from "@pwragent/shared";
import type { StateDb } from "./state-db.js";
/** Only SQLite index fields and the existing defensive payload guard belong here.
 * Launch descriptors, capabilities and registry policy remain host-owned. */
export type AcpRegistryCacheRecord = { fetchedAt: number };
export type AcpInstalledAgentStorageRecord = {
  backendId: AcpBackendId;
  registryId: string;
  name: string;
  version?: string;
  installStatus: string;
  authStatus: string;
  verificationStatus: string;
  installedAt: number;
  updatedAt: number;
};

const REGISTRY_CACHE_KEY = "latest";

export class AcpAgentStore<
  RegistrySnapshot extends AcpRegistryCacheRecord = AcpRegistryCacheRecord,
  InstalledAgentRecord extends AcpInstalledAgentStorageRecord = AcpInstalledAgentStorageRecord,
> implements AcpAgentStorage<RegistrySnapshot, InstalledAgentRecord> {
  constructor(private readonly stateDb: StateDb) {}

  saveRegistrySnapshot(snapshot: RegistrySnapshot): void {
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO acp_registry_cache(cache_key, fetched_at, payload)
         VALUES (?, ?, ?)`,
      )
      .run(REGISTRY_CACHE_KEY, snapshot.fetchedAt, JSON.stringify(snapshot));
  }

  readRegistrySnapshot(): RegistrySnapshot | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT payload FROM acp_registry_cache WHERE cache_key = ?`,
      )
      .get(REGISTRY_CACHE_KEY) as { payload: string } | undefined;
    if (!row) {
      return undefined;
    }
    return parseJson(row.payload) as RegistrySnapshot | undefined;
  }

  upsertInstalledAgent(record: InstalledAgentRecord): void {
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO acp_installed_agents(
           backend_id,
           registry_id,
           version,
           install_status,
           auth_status,
           verification_status,
           installed_at,
           updated_at,
           payload
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.backendId,
        record.registryId,
        record.version ?? null,
        record.installStatus,
        record.authStatus,
        record.verificationStatus,
        record.installedAt,
        record.updatedAt,
        JSON.stringify(record),
      );
  }

  listInstalledAgents(): InstalledAgentRecord[] {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT payload FROM acp_installed_agents ORDER BY registry_id COLLATE NOCASE`,
      )
      .all() as Array<{ payload: string }>;

    return rows.flatMap((row) => {
      const parsed = parseJson(row.payload);
      return isInstalledRecord<InstalledAgentRecord>(parsed) ? [parsed] : [];
    });
  }

  getInstalledAgent(backendId: AcpBackendId): InstalledAgentRecord | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT payload FROM acp_installed_agents WHERE backend_id = ?`,
      )
      .get(backendId) as { payload: string } | undefined;

    const parsed = row ? parseJson(row.payload) : undefined;
    return isInstalledRecord<InstalledAgentRecord>(parsed) ? parsed : undefined;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isInstalledRecord<InstalledAgentRecord extends AcpInstalledAgentStorageRecord>(value: unknown): value is InstalledAgentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.backendId === "string" &&
    record.backendId.startsWith("acp:") &&
    typeof record.registryId === "string" &&
    typeof record.name === "string" &&
    typeof record.installStatus === "string" &&
    typeof record.authStatus === "string" &&
    typeof record.verificationStatus === "string"
  );
}
