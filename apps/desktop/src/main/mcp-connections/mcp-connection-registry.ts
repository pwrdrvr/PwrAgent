import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  PWRSNAP_MCP_CONNECTION_ID,
  type McpConnectionRecord,
} from "@pwragent/shared";
import { resolveDesktopConfigPath } from "../settings/desktop-config";
import {
  applyTomlEdits,
  parseTomlTables,
  type TomlEditScalar,
} from "../settings/toml-editor";

const CONNECTIONS_TABLE = ["mcp_connections", "connections"] as const;
// PwrSnap is synthesized rather than stored, so it has no row to carry an
// `enabled` flag. A scalar beside the table records the one piece of PwrSnap
// state the operator owns, without a phantom row that `create` and `remove`
// would have to preserve on every rewrite.
const PWRSNAP_ENABLED_PATH = ["mcp_connections", "pwrsnap_enabled"] as const;
const CONNECTION_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const PWRSNAP_SERVER_URL = "http://127.0.0.1:51729/mcp";

type StoredConnectionRow = Record<
  string,
  TomlEditScalar | string[]
>;

export type McpConnectionRegistryOptions = {
  configPath?: string;
  now?: () => number;
  randomId?: () => string;
};

export class McpConnectionRegistry {
  private readonly configPath: string;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(options: McpConnectionRegistryOptions = {}) {
    this.configPath = options.configPath ?? resolveDesktopConfigPath();
    this.now = options.now ?? Date.now;
    this.randomId =
      options.randomId ?? (() => randomBytes(5).toString("base64url").toLowerCase());
  }

  list(): McpConnectionRecord[] {
    return [this.pwrSnapConnection(), ...this.readStoredConnections()];
  }

  get(connectionId: string): McpConnectionRecord | undefined {
    if (connectionId === PWRSNAP_MCP_CONNECTION_ID) {
      return this.pwrSnapConnection();
    }
    return this.list().find((connection) => connection.id === connectionId);
  }

  /**
   * Park or restore a connection profile-wide.
   *
   * A disabled connection keeps its credentials and its authorization state;
   * it is simply withheld from threads. That is the difference between this
   * and `remove`, which discards the connection outright.
   */
  setEnabled(connectionId: string, enabled: boolean): McpConnectionRecord {
    if (connectionId === PWRSNAP_MCP_CONNECTION_ID) {
      this.writeScalar(PWRSNAP_ENABLED_PATH, enabled);
      return this.pwrSnapConnection();
    }
    const current = this.readStoredConnections();
    const target = current.find((connection) => connection.id === connectionId);
    if (!target) {
      throw new Error("That MCP connection no longer exists.");
    }
    if (target.enabled === enabled) return target;
    const updated: McpConnectionRecord = {
      ...target,
      enabled,
      updatedAt: this.now(),
    };
    this.writeStoredConnections(
      current.map((connection) =>
        connection.id === connectionId ? updated : connection,
      ),
    );
    return updated;
  }

  private pwrSnapConnection(): McpConnectionRecord {
    return { ...builtInPwrSnapConnection(), enabled: this.readPwrSnapEnabled() };
  }

  private readPwrSnapEnabled(): boolean {
    if (!fs.existsSync(this.configPath)) return true;
    const source = fs.readFileSync(this.configPath, "utf8");
    const table = parseTomlTables(source, this.configPath).mcp_connections;
    return (table as Record<string, unknown> | undefined)?.pwrsnap_enabled
      !== false;
  }

  private writeScalar(path: readonly string[], value: boolean): void {
    this.writeConfig((source) =>
      applyTomlEdits(source, [{ op: "set", path, value }]),
    );
  }

  create(input: {
    displayName: string;
    serverUrl: string;
  }): McpConnectionRecord {
    const displayName = normalizeDisplayName(input.displayName);
    const serverUrl = normalizeMcpServerUrl(input.serverUrl);
    const current = this.readStoredConnections();
    const id = this.uniqueId(displayName, current);
    const now = this.now();
    const connection: McpConnectionRecord = {
      id,
      displayName,
      serverUrl,
      authMode: "oauth",
      kind: "remote",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.writeStoredConnections([...current, connection]);
    return connection;
  }

  remove(connectionId: string): boolean {
    if (connectionId === PWRSNAP_MCP_CONNECTION_ID) {
      throw new Error("The built-in PwrSnap connection cannot be removed.");
    }
    const current = this.readStoredConnections();
    const next = current.filter((connection) => connection.id !== connectionId);
    if (next.length === current.length) return false;
    this.writeStoredConnections(next);
    return true;
  }

  private readStoredRows(): StoredConnectionRow[] {
    if (!fs.existsSync(this.configPath)) return [];
    const source = fs.readFileSync(this.configPath, "utf8");
    const rows = parseTomlTables(source, this.configPath).mcp_connections
      ?.connections;
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (raw): raw is StoredConnectionRow =>
        Boolean(raw) && !Array.isArray(raw) && typeof raw === "object",
    );
  }

  private readStoredConnections(): McpConnectionRecord[] {
    const connections: McpConnectionRecord[] = [];
    const ids = new Set<string>([PWRSNAP_MCP_CONNECTION_ID]);
    for (const row of this.readStoredRows()) {
      const connection = connectionFromRow(row);
      if (!connection || ids.has(connection.id)) continue;
      ids.add(connection.id);
      connections.push(connection);
    }
    return connections;
  }

  /**
   * Rewrite the stored rows from the rows already on disk.
   *
   * `setTableArray` replaces the whole block, so serializing only the rows
   * this build accepted would delete every other one during an unrelated
   * write — a hand-authored entry with a typo, a row a newer build wrote, an
   * `id = "pwrsnap"` override. Those belong to the operator, and a toggle of
   * a different connection is no place to discard them. Rewriting a known
   * row also merges rather than replaces, so fields this build does not
   * understand survive. Comments *inside* the block are still lost; the TOML
   * editor rewrites the block as a unit.
   */
  private writeStoredConnections(connections: McpConnectionRecord[]): void {
    const byId = new Map(
      connections.map((connection) => [connection.id, connection]),
    );
    const emitted = new Set<string>();
    const rows: StoredConnectionRow[] = [];
    for (const row of this.readStoredRows()) {
      const parsed = connectionFromRow(row);
      if (!parsed) {
        rows.push(row);
        continue;
      }
      const next = byId.get(parsed.id);
      // A row whose id is gone from the new set was removed. A later row
      // repeating an id already written is a duplicate the read path was
      // ignoring anyway, and keeping it would resurrect a removed
      // connection on the next read.
      if (!next || emitted.has(parsed.id)) continue;
      emitted.add(parsed.id);
      rows.push({ ...row, ...connectionToRow(next) });
    }
    for (const connection of connections) {
      if (emitted.has(connection.id)) continue;
      rows.push(connectionToRow(connection));
    }
    this.writeConfig((source) =>
      applyTomlEdits(source, [{
        op: "setTableArray",
        path: CONNECTIONS_TABLE,
        value: rows,
      }]),
    );
  }

  private writeConfig(edit: (source: string) => string): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const source = fs.existsSync(this.configPath)
      ? fs.readFileSync(this.configPath, "utf8")
      : "";
    const next = edit(source);
    if (next === source) return;
    const temporaryPath = `${this.configPath}.${process.pid}.mcp.tmp`;
    fs.writeFileSync(temporaryPath, next, "utf8");
    fs.renameSync(temporaryPath, this.configPath);
  }

  private uniqueId(
    displayName: string,
    connections: readonly McpConnectionRecord[],
  ): string {
    const base = slugifyConnectionId(displayName);
    const ids = new Set(connections.map((connection) => connection.id));
    if (!ids.has(base) && base !== PWRSNAP_MCP_CONNECTION_ID) return base;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = `${base.slice(0, 54)}-${this.randomId()}`;
      if (CONNECTION_ID_PATTERN.test(candidate) && !ids.has(candidate)) {
        return candidate;
      }
    }
    throw new Error("Could not allocate a unique MCP connection ID.");
  }
}

export function normalizeMcpServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid MCP server URL.");
  }
  if (url.username || url.password) {
    throw new Error("MCP server URLs cannot contain credentials.");
  }
  if (url.hash) {
    throw new Error("MCP server URLs cannot contain fragments.");
  }
  const loopback =
    url.hostname === "127.0.0.1"
    || url.hostname === "localhost"
    || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Remote MCP servers must use HTTPS.");
  }
  return url.href;
}

function builtInPwrSnapConnection(): McpConnectionRecord {
  return {
    id: PWRSNAP_MCP_CONNECTION_ID,
    displayName: "PwrSnap",
    serverUrl: PWRSNAP_SERVER_URL,
    authMode: "oauth",
    kind: "pwrsnap",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

function normalizeDisplayName(value: string): string {
  const displayName = value.trim().replace(/\s+/g, " ");
  if (!displayName) throw new Error("Enter a connection name.");
  if (displayName.length > 80) {
    throw new Error("Connection names must be 80 characters or fewer.");
  }
  return displayName;
}

function slugifyConnectionId(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return /^[a-z]/.test(slug) ? slug : `mcp-${slug || "connection"}`;
}

function connectionToRow(
  connection: McpConnectionRecord,
): Record<string, TomlEditScalar> {
  return {
    id: connection.id,
    display_name: connection.displayName,
    server_url: connection.serverUrl,
    auth_mode: connection.authMode,
    enabled: connection.enabled,
    created_at: connection.createdAt,
    updated_at: connection.updatedAt,
  };
}

function connectionFromRow(
  row: StoredConnectionRow,
): McpConnectionRecord | undefined {
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const displayName =
    typeof row.display_name === "string" ? row.display_name.trim() : "";
  const serverUrl =
    typeof row.server_url === "string" ? row.server_url.trim() : "";
  if (!CONNECTION_ID_PATTERN.test(id) || !displayName || !serverUrl) {
    return undefined;
  }
  try {
    return {
      id,
      displayName,
      serverUrl: normalizeMcpServerUrl(serverUrl),
      authMode: "oauth",
      kind: "remote",
      enabled: row.enabled !== false,
      createdAt: typeof row.created_at === "number" ? row.created_at : 0,
      updatedAt: typeof row.updated_at === "number" ? row.updated_at : 0,
    };
  } catch {
    return undefined;
  }
}
