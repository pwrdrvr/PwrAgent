import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";

/**
 * Secret environment values for local command connections.
 *
 * One encrypted blob in the profile's secret store, separate from the OAuth
 * credential envelope, keyed by connection id and then by variable name. The
 * plain variables live in `config.toml` beside the command; only the names of
 * the secret ones do. Values leave the main process only as a launched
 * server's environment.
 */
type SecretEnvelope = {
  version: 1;
  connections: Record<string, Record<string, string>>;
};

export type McpStdioSecretSettings = Pick<
  ReturnType<typeof getDesktopSettingsService>,
  | "resolveMcpStdioConnectionSecrets"
  | "saveMcpStdioConnectionSecrets"
  | "clearMcpStdioConnectionSecrets"
>;

export class McpStdioSecretVault {
  private resolvedSettings?: McpStdioSecretSettings;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: { settings?: McpStdioSecretSettings } = {}) {}

  // Resolved on first use, so a gateway that never meets a local command
  // never opens the secret store for one.
  private get settings(): McpStdioSecretSettings {
    this.resolvedSettings ??= this.options.settings ?? getDesktopSettingsService();
    return this.resolvedSettings;
  }

  /** The stored values for one connection. Throws when storage is unreadable. */
  async read(connectionId: string): Promise<Record<string, string>> {
    return { ...((await this.readEnvelope()).connections[connectionId] ?? {}) };
  }

  /**
   * Replace one connection's values. An empty set removes the entry. The
   * write is read back, because a secret store that silently drops a value
   * would otherwise surface much later as a server that cannot start.
   */
  async write(connectionId: string, values: Record<string, string>): Promise<void> {
    await this.enqueue(async () => {
      const envelope = await this.readEnvelope();
      if (Object.keys(values).length === 0) {
        if (!(connectionId in envelope.connections)) return;
        delete envelope.connections[connectionId];
      } else {
        envelope.connections[connectionId] = { ...values };
      }
      await this.persist(envelope);
      const saved = (await this.readEnvelope()).connections[connectionId] ?? {};
      if (JSON.stringify(sorted(saved)) !== JSON.stringify(sorted(values))) {
        throw new Error(
          "PwrAgent could not save this server's secrets. Encrypted storage may be unavailable.",
        );
      }
    });
  }

  async delete(connectionId: string): Promise<void> {
    await this.write(connectionId, {});
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  private async readEnvelope(): Promise<SecretEnvelope> {
    const raw = await this.settings.resolveMcpStdioConnectionSecrets();
    if (!raw) return { version: 1, connections: {} };
    try {
      const parsed = JSON.parse(raw) as Partial<SecretEnvelope>;
      if (parsed.version !== 1 || !parsed.connections || typeof parsed.connections !== "object") {
        throw new Error("invalid envelope");
      }
      const connections: SecretEnvelope["connections"] = {};
      for (const [id, values] of Object.entries(parsed.connections)) {
        if (!values || typeof values !== "object" || Array.isArray(values)) continue;
        connections[id] = Object.fromEntries(
          Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      }
      return { version: 1, connections };
    } catch (cause) {
      throw new Error("The encrypted store of MCP server secrets is unreadable.", { cause });
    }
  }

  private async persist(envelope: SecretEnvelope): Promise<void> {
    if (Object.keys(envelope.connections).length === 0) {
      await this.settings.clearMcpStdioConnectionSecrets();
      return;
    }
    await this.settings.saveMcpStdioConnectionSecrets(JSON.stringify(envelope));
  }
}

function sorted(values: Record<string, string>): Array<[string, string]> {
  return Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
}
