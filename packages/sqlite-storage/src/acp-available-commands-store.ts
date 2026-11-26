import type { AcpAvailableCommandsRecord, AcpAvailableCommandsStorage } from "@pwragent/owner-core/acp-storage";
import type {
  AcpBackendId,
  AppServerAvailableCommandSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { StateDb } from "./state-db.js";

export class AcpAvailableCommandsStore implements AcpAvailableCommandsStorage {
  constructor(private readonly stateDb: StateDb) {}

  get(
    backendId: AcpBackendId,
    repositoryPath: string,
  ): AcpAvailableCommandsRecord | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT observed_at, payload FROM acp_available_commands
         WHERE backend_id = ? AND repository_path = ?`,
      )
      .get(backendId, repositoryPath) as
      | { observed_at: number; payload: string }
      | undefined;
    if (!row) {
      return undefined;
    }

    const catalog = parseCatalog(row.payload);
    return catalog
      ? {
          backendId,
          repositoryPath,
          ...catalog,
          observedAt: row.observed_at,
        }
      : undefined;
  }

  upsert(record: AcpAvailableCommandsRecord): void {
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO acp_available_commands(
           backend_id,
           repository_path,
           observed_at,
           payload
         )
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        record.backendId,
        record.repositoryPath,
        record.observedAt,
        JSON.stringify(record.workspaceCwd
          ? { commands: record.commands, workspaceCwd: record.workspaceCwd }
          : record.commands),
      );
  }
}

function parseCatalog(
  payload: string,
): Pick<AcpAvailableCommandsRecord, "commands" | "workspaceCwd"> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const catalog = parsed && typeof parsed === "object"
    ? parsed as { commands?: unknown; workspaceCwd?: unknown }
    : undefined;
  const commands = Array.isArray(parsed) ? parsed : catalog?.commands;
  if (!Array.isArray(commands)) return undefined;
  return {
    commands: commands.filter(
      (entry): entry is AppServerAvailableCommandSummary =>
        Boolean(entry)
        && typeof entry === "object"
        && typeof (entry as { name?: unknown }).name === "string",
    ),
    ...(typeof catalog?.workspaceCwd === "string" ? { workspaceCwd: catalog.workspaceCwd } : {}),
  };
}
