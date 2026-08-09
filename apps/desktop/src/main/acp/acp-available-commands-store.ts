import type {
  AcpBackendId,
  AppServerAvailableCommandSummary,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db.js";

export type AcpAvailableCommandsRecord = {
  backendId: AcpBackendId;
  repositoryPath: string;
  commands: AppServerAvailableCommandSummary[];
  observedAt: number;
};

/**
 * Durable last-observed slash-command list per (ACP agent, repository root).
 *
 * ACP advertises `availableCommands` only through `session/update` on a live
 * session, so a launchpad draft — no thread, no session — cannot ask for them.
 * Live sessions write through here as they report, and launchpad requests read
 * back the repo's last-known list. Rows are keyed by repository root rather
 * than by cwd so every worktree of a checkout shares one entry.
 */
export type AcpAvailableCommandsStoreLike = {
  get(
    backendId: AcpBackendId,
    repositoryPath: string,
  ): AcpAvailableCommandsRecord | undefined;
  upsert(record: AcpAvailableCommandsRecord): void;
};

export class AcpAvailableCommandsStore implements AcpAvailableCommandsStoreLike {
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

    const commands = parseCommands(row.payload);
    return commands
      ? {
          backendId,
          repositoryPath,
          commands,
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
        JSON.stringify(record.commands),
      );
  }
}

function parseCommands(
  payload: string,
): AppServerAvailableCommandSummary[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed.filter(
    (entry): entry is AppServerAvailableCommandSummary =>
      Boolean(entry)
      && typeof entry === "object"
      && typeof (entry as { name?: unknown }).name === "string",
  );
}
