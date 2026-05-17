import type { AcpBackendId } from "@pwragent/shared";
import type { StateDb } from "../state/state-db.js";
import type {
  AcpInstalledAgentRecord,
  AcpRegistrySnapshot,
} from "./acp-registry-types.js";

const REGISTRY_CACHE_KEY = "latest";

export class AcpAgentStore {
  constructor(private readonly stateDb: StateDb) {}

  saveRegistrySnapshot(snapshot: AcpRegistrySnapshot): void {
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO acp_registry_cache(cache_key, fetched_at, payload)
         VALUES (?, ?, ?)`,
      )
      .run(REGISTRY_CACHE_KEY, snapshot.fetchedAt, JSON.stringify(snapshot));
  }

  readRegistrySnapshot(): AcpRegistrySnapshot | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT payload FROM acp_registry_cache WHERE cache_key = ?`,
      )
      .get(REGISTRY_CACHE_KEY) as { payload: string } | undefined;
    if (!row) {
      return undefined;
    }
    return parseJson(row.payload) as AcpRegistrySnapshot | undefined;
  }

  upsertInstalledAgent(record: AcpInstalledAgentRecord): void {
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

  listInstalledAgents(): AcpInstalledAgentRecord[] {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT payload FROM acp_installed_agents ORDER BY registry_id COLLATE NOCASE`,
      )
      .all() as Array<{ payload: string }>;

    return rows.flatMap((row) => {
      const parsed = parseJson(row.payload);
      return isInstalledRecord(parsed) ? [parsed] : [];
    });
  }

  getInstalledAgent(backendId: AcpBackendId): AcpInstalledAgentRecord | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT payload FROM acp_installed_agents WHERE backend_id = ?`,
      )
      .get(backendId) as { payload: string } | undefined;

    const parsed = row ? parseJson(row.payload) : undefined;
    return isInstalledRecord(parsed) ? parsed : undefined;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isInstalledRecord(value: unknown): value is AcpInstalledAgentRecord {
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
