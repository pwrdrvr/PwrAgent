import type { Transport, FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  BOAT_LINKS,
  BOAT_MCP_CONNECTION_ID,
  normalizeBoatApiKey,
  type BoatAccountSummary,
  type BoatLinkTarget,
  type BoatSandboxPolicy,
  type McpConnectionStatus,
  type OpenBoatLinkResponse,
} from "@pwragent/shared/contracts/mcp-connections";
import { BoatApi, BoatApiError } from "./boat-api";
import {
  BOAT_SERVER_INSTRUCTIONS,
  BoatTools,
  type BoatOwnedSandbox,
  type BoatToolRole,
} from "./boat-tools";
import { mcpInMemory, mcpServer, mcpTypes } from "./mcp-sdk";

/**
 * PwrAgent's Boat connection: the stored API key, the account behind it, and
 * the in-process MCP server each thread session talks to.
 *
 * The key lives in the profile's encrypted secret store and is read only
 * here, for a request to Boat. It is never placed in a process environment,
 * a config file, a log line, a tool result or a federation payload.
 */

/** The name the key is stored under in the connection's secret entry. */
export const BOAT_API_KEY_SECRET = "BOAT_API_KEY";
const STATUS_CACHE_MS = 60_000;

type BoatStatus = Pick<McpConnectionStatus, "configured" | "state" | "detail" | "boatAccount">;

export type BoatSecretStore = {
  read(connectionId: string): Promise<Record<string, string>>;
  write(connectionId: string, values: Record<string, string>): Promise<void>;
};

export type BoatSessionScope = {
  role: BoatToolRole;
  ownedSandboxIds: () => ReadonlySet<string>;
  recordOwned: (sandbox: BoatOwnedSandbox) => void;
  forgetOwned: (sandboxId: string) => void;
};

export type BoatConnectionOptions = {
  secrets: BoatSecretStore;
  fetchFn: FetchLike;
  policy: () => BoatSandboxPolicy;
  openExternal: (url: string) => Promise<void>;
  now?: () => number;
};

export class BoatConnection {
  private readonly api: BoatApi;
  private cached?: { at: number; value: BoatStatus };
  private pending?: Promise<BoatStatus>;
  /** Set when Boat refuses the stored key, until a new key is saved. */
  private rejected = false;
  /**
   * Set when Boat refuses a create for the stored key's actions, until a new
   * key is saved. Only a create can show it, so a refresh does not clear it.
   */
  private cannotCreate = false;
  private readonly statusListeners = new Set<() => void>();

  constructor(private readonly options: BoatConnectionOptions) {
    this.api = new BoatApi({
      readKey: async () => await this.readKey(),
      fetchFn: options.fetchFn,
      onRejected: () => {
        if (this.rejected) return;
        this.rejected = true;
        this.cached = undefined;
        for (const listener of this.statusListeners) listener();
      },
      onCannotCreate: () => {
        if (this.cannotCreate) return;
        this.cannotCreate = true;
        this.cached = undefined;
        for (const listener of this.statusListeners) listener();
      },
    });
  }

  onStatusChanged(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Snapshot for latency-sensitive reads; never calls Boat. */
  cachedStatus(): BoatStatus {
    return this.cached?.value ?? {
      configured: false,
      state: "connecting",
      detail: "Boat status has not been checked yet. Refresh status in Settings → Plugins.",
    };
  }

  /** Concurrent reads share one check. `refresh` skips the cache. */
  async readStatus(refresh = false): Promise<BoatStatus> {
    const now = this.options.now?.() ?? Date.now();
    // An asked-for refresh checks the key again: one refused request must
    // not hold Boat off until a new key is pasted.
    if (refresh) this.rejected = false;
    if (!refresh && this.cached && now - this.cached.at < STATUS_CACHE_MS) return this.cached.value;
    if (this.pending) return await this.pending;
    const pending = this.probe().then((value) => {
      // The first answer is news only when a key is stored: until then every
      // reader already shows Boat as not connected.
      const changed = this.cached
        ? JSON.stringify(this.cached.value) !== JSON.stringify(value)
        : value.configured;
      this.cached = { at: this.options.now?.() ?? Date.now(), value };
      if (changed) for (const listener of this.statusListeners) listener();
      return value;
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return await pending;
  }

  /**
   * Checks a pasted key against Boat, then stores it. A key Boat refuses is
   * never stored. The key is not echoed back in any outcome.
   */
  async connect(apiKey: unknown): Promise<BoatStatus> {
    const key = normalizeBoatApiKey(apiKey);
    if (!key) {
      throw new Error("That does not look like a Boat API key. Boat keys start with boat_.");
    }
    try {
      await this.api.requestWithKey(key, { method: "GET", path: ["limits"] });
    } catch (error) {
      if (error instanceof BoatApiError && error.kind === "rejected") {
        throw new Error("Boat rejected that API key. Check that it was copied whole and has not expired.");
      }
      // Boat knew the key and refused only the limits read: the key is
      // good, and narrower than this check. It is stored.
      if (error instanceof BoatApiError && error.kind === "failed" && error.code !== "api_key_action_forbidden") {
        throw new Error(`Boat could not check that key (${error.code ?? error.status ?? "error"}). Try again.`);
      }
      // A full plan or an outage says nothing against the key itself.
      if (!(error instanceof BoatApiError) || error.kind === "unavailable") {
        throw new Error("Could not reach Boat to check that key. Check connectivity and try again.");
      }
    }
    await this.options.secrets.write(BOAT_MCP_CONNECTION_ID, { [BOAT_API_KEY_SECRET]: key });
    this.rejected = false;
    this.cannotCreate = false;
    this.cached = undefined;
    return await this.readStatus(true);
  }

  /** Removes the stored key. Does not revoke it at Boat. */
  async disconnect(): Promise<void> {
    await this.options.secrets.write(BOAT_MCP_CONNECTION_ID, {});
    this.rejected = false;
    this.cannotCreate = false;
    this.cached = undefined;
    for (const listener of this.statusListeners) listener();
  }

  async openLink(target: BoatLinkTarget): Promise<OpenBoatLinkResponse> {
    try {
      await this.options.openExternal(BOAT_LINKS[target]);
      return { opened: true };
    } catch {
      return { opened: false, error: "Could not open the Boat page." };
    }
  }

  /**
   * One MCP session's tools, served in this process. The returned transport
   * is the client's end; closing it closes the server.
   */
  async createTransport(scope: BoatSessionScope): Promise<Transport> {
    const [{ Server }, { InMemoryTransport }, types] = await Promise.all([
      mcpServer.load(),
      mcpInMemory.load(),
      mcpTypes.load(),
    ]);
    const tools = new BoatTools({ api: this.api, policy: this.options.policy, ...scope });
    const server = new Server({ name: "pwragent-boat", version: "1" }, {
      capabilities: { tools: {} },
      instructions: BOAT_SERVER_INSTRUCTIONS,
    });
    server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools: [...tools.list()] }));
    server.setRequestHandler(types.CallToolRequestSchema, async (request, extra) =>
      await tools.call(request.params.name, request.params.arguments, extra.signal, async (message) => {
        // A form with no fields: the person approves or declines. It reaches
        // them through the tool call that asked, or not at all.
        try {
          const answer = await server.elicitInput(
            { message, requestedSchema: { type: "object", properties: {} } },
            { signal: extra.signal },
          );
          return answer.action === "accept" ? "approved" : "declined";
        } catch (error) {
          if (extra.signal.aborted) throw error;
          return "unavailable";
        }
      }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  }

  private async readKey(): Promise<string | undefined> {
    const stored = await this.options.secrets.read(BOAT_MCP_CONNECTION_ID);
    return Object.hasOwn(stored, BOAT_API_KEY_SECRET) ? stored[BOAT_API_KEY_SECRET] : undefined;
  }

  private async probe(): Promise<BoatStatus> {
    let key: string | undefined;
    try {
      key = await this.readKey();
    } catch {
      return {
        configured: false, state: "temporarily_unavailable",
        detail: "PwrAgent could not read the stored Boat API key. Secret storage may be unavailable.",
      };
    }
    if (!key) {
      return {
        configured: false, state: "disconnected",
        detail: "Paste a Boat API key to connect. PwrAgent keeps it encrypted and never shows it to an agent.",
      };
    }
    if (this.rejected) return REJECTED;
    if (this.cannotCreate) return CANNOT_CREATE;
    try {
      const limits = await this.api.requestWithKey(key, { method: "GET", path: ["limits"] });
      const boatAccount = accountSummary(limits);
      return boatAccount.canStart === false
        ? {
            configured: true, state: "ready", boatAccount,
            detail: `Boat will not start a new sandbox for this account${
              boatAccount.blockedReason ? ` (${boatAccount.blockedReason})` : ""
            }. Running sandboxes can still be listed and stopped. Check the Boat dashboard.`,
          }
        : {
            configured: true, state: "ready", boatAccount,
            detail: "Connected with an API key stored in this profile. Sandboxes bill per second while they run.",
          };
    } catch (error) {
      if (error instanceof BoatApiError && error.kind === "rejected") {
        this.rejected = true;
        return REJECTED;
      }
      if (error instanceof BoatApiError && error.code === "api_key_action_forbidden") {
        return {
          configured: true, state: "ready",
          detail: "Connected with an API key stored in this profile. The key cannot read account limits, so the plan is not shown here.",
        };
      }
      if (error instanceof BoatApiError && error.kind === "limited") {
        // The key works; the account is at a limit. Threads keep list and stop.
        return { configured: true, state: "ready", detail: error.message, boatAccount: { canStart: false } };
      }
      return {
        configured: true, state: "temporarily_unavailable",
        detail: "Could not check Boat. The stored key is kept; check connectivity, then refresh status.",
      };
    }
  }
}

const REJECTED: BoatStatus = {
  configured: false, state: "reauthorization_required",
  detail: "Boat rejected the stored API key. It may have expired or been revoked. Paste a new one.",
};

/** The key is kept: it may still list and stop what is running. */
const CANNOT_CREATE: BoatStatus = {
  configured: true, state: "reauthorization_required",
  detail: "The stored Boat API key is not allowed to create sandboxes. Sign in again to replace it.",
};

function accountSummary(limits: Record<string, unknown>): BoatAccountSummary {
  const account: BoatAccountSummary = {};
  if (typeof limits.accessTier === "string" && limits.accessTier) account.plan = limits.accessTier.slice(0, 40);
  if (typeof limits.activeSandboxes === "number") account.activeSandboxes = limits.activeSandboxes;
  if (typeof limits.maxActiveSandboxes === "number") account.maxActiveSandboxes = limits.maxActiveSandboxes;
  if (typeof limits.canStart === "boolean") account.canStart = limits.canStart;
  if (typeof limits.startBlockedReason === "string" && limits.startBlockedReason) {
    account.blockedReason = limits.startBlockedReason.slice(0, 200);
  }
  return account;
}
