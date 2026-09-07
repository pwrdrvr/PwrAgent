import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { PWRSNAP_MCP_CONNECTION_ID } from "@pwragent/shared";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";

export type McpOAuthCredential = {
  resourceUrl: string;
  redirectUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  tokens?: OAuthTokens;
};

type CredentialEnvelope = {
  version: 1;
  credentials: Record<string, McpOAuthCredential>;
};

type CredentialSettings = Pick<
  ReturnType<typeof getDesktopSettingsService>,
  | "clearMcpConnectionCredentials"
  | "resolveMcpConnectionCredentials"
  | "resolvePwrSnapMcpCredential"
  | "saveMcpConnectionCredentials"
>;

export type McpCredentialVaultOptions = {
  settings?: CredentialSettings;
};

export class McpCredentialVault {
  private readonly settings: CredentialSettings;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: McpCredentialVaultOptions = {}) {
    this.settings = options.settings ?? getDesktopSettingsService();
  }

  async read(
    connectionId: string,
    resourceUrl: string,
  ): Promise<McpOAuthCredential | undefined> {
    const envelope = await this.readEnvelope();
    const stored = envelope.credentials[connectionId];
    if (stored?.resourceUrl === resourceUrl) return cloneCredential(stored);
    if (connectionId !== PWRSNAP_MCP_CONNECTION_ID || stored) return undefined;

    const legacy = parseCredential(
      await this.settings.resolvePwrSnapMcpCredential(),
      resourceUrl,
    );
    if (!legacy) return undefined;
    await this.write(connectionId, legacy);
    return cloneCredential(legacy);
  }

  async write(
    connectionId: string,
    credential: McpOAuthCredential,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const envelope = await this.readEnvelope();
      envelope.credentials[connectionId] = cloneCredential(credential);
      await this.persistEnvelope(envelope);
      const persisted = await this.readEnvelope();
      const saved = persisted.credentials[connectionId];
      if (!saved || JSON.stringify(saved) !== JSON.stringify(credential)) {
        throw new Error(
          "PwrAgent could not durably save the MCP authorization. Secret storage may be unavailable.",
        );
      }
    });
  }

  async delete(connectionId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const envelope = await this.readEnvelope();
      if (!(connectionId in envelope.credentials)) return;
      delete envelope.credentials[connectionId];
      await this.persistEnvelope(envelope);
    });
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  private async readEnvelope(): Promise<CredentialEnvelope> {
    const raw = await this.settings.resolveMcpConnectionCredentials();
    if (!raw) return { version: 1, credentials: {} };
    try {
      const parsed = JSON.parse(raw) as Partial<CredentialEnvelope>;
      if (
        parsed.version !== 1
        || !parsed.credentials
        || typeof parsed.credentials !== "object"
        || Array.isArray(parsed.credentials)
      ) {
        throw new Error("invalid envelope");
      }
      return {
        version: 1,
        credentials: Object.fromEntries(
          Object.entries(parsed.credentials)
            .filter((entry): entry is [string, McpOAuthCredential] =>
              isCredential(entry[1]),
            )
            .map(([id, credential]) => [id, cloneCredential(credential)]),
        ),
      };
    } catch (cause) {
      throw new Error(
        "The encrypted MCP connection credential store is unreadable.",
        { cause },
      );
    }
  }

  private async persistEnvelope(envelope: CredentialEnvelope): Promise<void> {
    if (Object.keys(envelope.credentials).length === 0) {
      await this.settings.clearMcpConnectionCredentials();
      return;
    }
    await this.settings.saveMcpConnectionCredentials(JSON.stringify(envelope));
  }
}

function parseCredential(
  value: string | undefined,
  resourceUrl: string,
): McpOAuthCredential | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Omit<McpOAuthCredential, "resourceUrl">;
    if (!parsed || typeof parsed !== "object") return undefined;
    return { ...parsed, resourceUrl };
  } catch {
    return undefined;
  }
}

function isCredential(value: unknown): value is McpOAuthCredential {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as McpOAuthCredential).resourceUrl === "string",
  );
}

function cloneCredential(
  credential: McpOAuthCredential,
): McpOAuthCredential {
  return structuredClone(credential);
}
