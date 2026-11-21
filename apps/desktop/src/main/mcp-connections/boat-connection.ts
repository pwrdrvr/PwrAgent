import fs from "node:fs/promises";
import type { Transport, FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BoatPortForwards, type BoatPortForward, type BoatTunnelRuntime } from "./boat-port-forward";
import { BoatWorkspaceError, type BoatWorkspace, type BoatWorkspaceGit } from "./boat-workspace";
import { runGitCommand } from "../app-server/git-executable";
import {
  BOAT_LINKS,
  BOAT_MCP_CONNECTION_ID,
  boatStartBlockForCode,
  boatStartBlockFromLimits,
  describeBoatStartBlock,
  normalizeBoatApiKey,
  type BoatAccountSummary,
  type BoatStartBlock,
  type BoatLinkTarget,
  type BoatSandboxPolicy,
  type McpConnectionStatus,
  type OpenBoatLinkResponse,
} from "@pwragent/shared/contracts/mcp-connections";
import { BoatApi, BoatApiError, type BoatAccountEvent } from "./boat-api";
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

/**
 * `key`: the stored key changed or Boat stopped accepting it, which ends what
 * every open session could do. `account`: only what the account can start
 * changed.
 */
export type BoatStatusChange = "key" | "account";

export type BoatSecretStore = {
  read(connectionId: string): Promise<Record<string, string>>;
  write(connectionId: string, values: Record<string, string>): Promise<void>;
};

export type BoatSessionScope = {
  role: BoatToolRole;
  ownedSandboxIds: () => ReadonlySet<string>;
  recordOwned: (sandbox: BoatOwnedSandbox) => void;
  forgetOwned: (sandboxId: string) => void;
  /** The thread's directories on this machine, its working directory first. */
  workspaceRoots?: () => Promise<readonly string[]>;
};

export type BoatConnectionOptions = {
  secrets: BoatSecretStore;
  fetchFn: FetchLike;
  policy: () => BoatSandboxPolicy;
  openExternal: (url: string) => Promise<void>;
  now?: () => number;
  /** Stands in for `ssh` and the file system under a port forward, in tests. */
  tunnelRuntime?: BoatTunnelRuntime;
  /** Runs Git in a thread directory for a push or pull. */
  git?: BoatWorkspaceGit;
};

export class BoatConnection {
  private readonly api: BoatApi;
  /**
   * The last status and the account generation it was read in. Every event
   * that can change how many sandboxes run (a create, resume, fork, stop or
   * delete settling, from any session or window) moves the generation on, so
   * a status read before it is not served as current, and a read that was
   * in flight when it happened is not stored as current either.
   */
  private cached?: { at: number; generation: number; value: BoatStatus };
  private pending?: { generation: number; promise: Promise<BoatStatus> };
  private generation = 0;
  /** Set when Boat refuses the stored key, until a new key is saved. */
  private rejected = false;
  /**
   * Set when Boat refuses a create for the stored key's actions, until a new
   * key is saved. Only a create can show it, so a refresh does not clear it.
   */
  private cannotCreate = false;
  private readonly statusListeners = new Set<(change: BoatStatusChange) => void>();
  private readonly forwards: BoatPortForwards;
  private nextSession = 0;

  constructor(private readonly options: BoatConnectionOptions) {
    this.forwards = new BoatPortForwards(options.tunnelRuntime);
    this.api = new BoatApi({
      readKey: async () => await this.readKey(),
      fetchFn: options.fetchFn,
      onRejected: () => {
        if (this.rejected) return;
        this.rejected = true;
        this.cached = undefined;
        this.announce("key");
      },
      onCannotCreate: () => {
        if (this.cannotCreate) return;
        this.cannotCreate = true;
        this.cached = undefined;
        this.announce("key");
      },
      onAccountEvent: (event) => this.learn(event),
      accountGeneration: () => this.generation,
    });
  }

  onStatusChanged(listener: (change: BoatStatusChange) => void): () => void {
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

  /**
   * Concurrent reads share one check. `refresh` skips the cache. A read that
   * starts after a sandbox change never gets an answer from before it.
   */
  async readStatus(refresh = false): Promise<BoatStatus> {
    // An asked-for refresh checks the key again: one refused request must
    // not hold Boat off until a new key is pasted.
    if (refresh) this.rejected = false;
    const cached = this.cached;
    if (
      !refresh
      && cached
      && cached.generation === this.generation
      && this.now() - cached.at < STATUS_CACHE_MS
    ) {
      return cached.value;
    }
    if (this.pending?.generation === this.generation) return await this.pending.promise;
    const generation = this.generation;
    const promise = this.probe().then((value) => {
      // Overtaken by a sandbox change: the caller that asked first gets it,
      // and the next read asks Boat again.
      if (generation === this.generation) this.store(value);
      return value;
    }).finally(() => {
      if (this.pending?.promise === promise) this.pending = undefined;
    });
    this.pending = { generation, promise };
    return await promise;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private announce(change: BoatStatusChange): void {
    for (const listener of this.statusListeners) listener(change);
  }

  /** Keeps a status as current for this generation, and says if it is news. */
  private store(value: BoatStatus): void {
    // The first answer is news only when a key is stored: until then every
    // reader already shows Boat as not connected.
    const previous = this.cached?.value;
    const changed = previous ? statusKey(previous) !== statusKey(value) : value.configured;
    this.cached = { at: this.now(), generation: this.generation, value };
    if (!changed) return;
    // Reachable or not is the connection's state, and what a tool listing
    // depends on; the account's capacity alone is not.
    const sameConnection = previous?.configured === value.configured && previous.state === value.state;
    this.announce(sameConnection ? "account" : "key");
  }

  /**
   * What a request with the stored key showed. Boat's account-wide count is
   * the truth: PwrAgent never works out capacity from its own records, which
   * miss sandboxes other threads, computers or Boat's site started.
   */
  private learn(event: BoatAccountEvent): void {
    switch (event.kind) {
      case "limits":
        // Read before a sandbox change settled: the next read asks again.
        if (event.since !== this.generation || this.rejected || this.cannotCreate) return;
        this.store(readyStatus(accountSummary(event.limits, this.now())));
        return;
      case "sandboxes_changed": {
        this.generation += 1;
        // Readers that show the last answer re-read; the next read asks Boat.
        if (this.cached) this.announce("account");
        return;
      }
      case "start_refused": {
        // Known at once, without asking Boat again. A read already in flight
        // may have been answered before the slot filled, so it is overtaken.
        if (this.rejected || this.cannotCreate) return;
        this.generation += 1;
        const previous = this.cached?.value.boatAccount;
        this.store(readyStatus(refusedAccount(previous, event.block, event.code, this.now())));
        return;
      }
    }
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
    this.generation += 1;
    return await this.readStatus(true);
  }

  /** Removes the stored key. Does not revoke it at Boat. */
  async disconnect(): Promise<void> {
    await this.options.secrets.write(BOAT_MCP_CONNECTION_ID, {});
    this.rejected = false;
    this.cannotCreate = false;
    this.cached = undefined;
    this.generation += 1;
    this.announce("key");
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
    const session = `session-${this.nextSession++}`;
    const { workspaceRoots, ...owned } = scope;
    const tools = new BoatTools({
      api: this.api,
      policy: this.options.policy,
      ...owned,
      forwards: { manager: this.forwards, session },
      ...(workspaceRoots ? { workspace: this.workspace(workspaceRoots) } : {}),
    });
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
    // The session's tunnels do not outlive it.
    server.onclose = () => void this.forwards.closeForSession(session);
    await server.connect(serverTransport);
    return clientTransport;
  }

  /**
   * One tool call outside any MCP session, for a window acting on a thread's
   * sandboxes. The scope's rules apply exactly as they do to an agent.
   */
  async callTool(scope: BoatSessionScope, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    // Holds the tunnels so a stop or delete from a window closes them too.
    // The session is never recorded: a window opens no tunnel of its own.
    const { workspaceRoots: _noDirectories, ...owned } = scope;
    return await new BoatTools({
      api: this.api,
      policy: this.options.policy,
      ...owned,
      forwards: { manager: this.forwards, session: "window" },
    }).call(name, args);
  }

  private workspace(roots: () => Promise<readonly string[]>): BoatWorkspace {
    const fetchFn = this.options.fetchFn;
    return {
      roots,
      git: this.options.git ?? (async (cwd, args) => await runGitCommand(cwd, args, { maxBuffer: 64 * 1024 * 1024 })),
      transfer: {
        // A signed URL is its own authority: the Boat key is not sent to it.
        upload: async (url, file, signal) => {
          const response = await fetchFn(url, {
            method: "PUT",
            body: await fs.readFile(file),
            redirect: "error",
            ...(signal ? { signal } : {}),
          });
          if (!response.ok) throw new BoatWorkspaceError(`Boat did not accept the upload (HTTP ${response.status}).`);
        },
        download: async (url, file, limitBytes, signal) => {
          const response = await fetchFn(url, { method: "GET", redirect: "error", ...(signal ? { signal } : {}) });
          if (!response.ok) throw new BoatWorkspaceError(`Boat did not return the changes (HTTP ${response.status}).`);
          const tooLarge = (): BoatWorkspaceError => new BoatWorkspaceError(
            `The sandbox's changes are more than the ${limitBytes / (1024 * 1024)} MiB a pull brings back. Nothing was changed.`,
          );
          // The declared length first, then the bytes as they arrive: never
          // more than the limit in memory, whatever the server says.
          if (Number(response.headers.get("content-length")) > limitBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw tooLarge();
          }
          const chunks: Uint8Array[] = [];
          let received = 0;
          const reader = response.body?.getReader();
          for (let part = await reader?.read(); part && !part.done; part = await reader?.read()) {
            received += part.value.byteLength;
            if (received > limitBytes) {
              await reader?.cancel().catch(() => undefined);
              throw tooLarge();
            }
            chunks.push(part.value);
          }
          await fs.writeFile(file, Buffer.concat(chunks), { mode: 0o600 });
        },
      },
    };
  }

  /** The tunnels open into these sandboxes. */
  portForwards(sandboxIds: ReadonlySet<string>): BoatPortForward[] {
    return this.forwards.list(sandboxIds);
  }

  /** Ends every tunnel: the app is quitting, or the key is gone. */
  async closePortForwards(): Promise<void> {
    await this.forwards.closeAll();
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
      return readyStatus(accountSummary(limits, this.now()));
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
        return readyStatus(refusedAccount(
          this.cached?.value.boatAccount,
          boatStartBlockForCode(error.code) ?? "other",
          error.code,
          this.now(),
        ));
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

/** A status without when it was read, to tell whether anything changed. */
function statusKey(status: BoatStatus): string {
  const { checkedAt: _checkedAt, ...account } = status.boatAccount ?? {};
  return JSON.stringify({ ...status, boatAccount: account });
}

function readyStatus(boatAccount: BoatAccountSummary): BoatStatus {
  return boatAccount.canStart === false
    ? {
        configured: true, state: "ready", boatAccount,
        detail: `${describeBoatStartBlock(boatAccount)} Running sandboxes can still be listed and stopped.`,
      }
    : {
        configured: true, state: "ready", boatAccount,
        detail: "Connected with an API key stored in this profile. Sandboxes bill per second while they run.",
      };
}

/**
 * The account as a refused start left it: what was last read, with the
 * refusal. `limit_reached` means every slot on the account is taken, so its
 * running count is at least the cap. (`member_limit_reached` is a smaller cap
 * an organization sets on one member, and says nothing about the account's.)
 */
function refusedAccount(
  previous: BoatAccountSummary | undefined,
  block: BoatStartBlock,
  code: string | undefined,
  checkedAt: number,
): BoatAccountSummary {
  const account: BoatAccountSummary = {
    ...previous,
    canStart: false,
    startBlock: block,
    checkedAt,
  };
  if (code) account.blockedReason = code.slice(0, 200);
  else delete account.blockedReason;
  if (code === "limit_reached" && account.maxActiveSandboxes !== undefined) {
    account.activeSandboxes = Math.max(account.activeSandboxes ?? 0, account.maxActiveSandboxes);
  }
  return account;
}

function accountSummary(limits: Record<string, unknown>, checkedAt: number): BoatAccountSummary {
  const account: BoatAccountSummary = { checkedAt };
  if (typeof limits.accessTier === "string" && limits.accessTier) account.plan = limits.accessTier.slice(0, 40);
  if (typeof limits.activeSandboxes === "number") account.activeSandboxes = limits.activeSandboxes;
  if (typeof limits.maxActiveSandboxes === "number") account.maxActiveSandboxes = limits.maxActiveSandboxes;
  if (typeof limits.canStart === "boolean") account.canStart = limits.canStart;
  if (typeof limits.startBlockedReason === "string" && limits.startBlockedReason) {
    account.blockedReason = limits.startBlockedReason.slice(0, 200);
  }
  const block = boatStartBlockFromLimits(limits);
  if (block) account.startBlock = block;
  return account;
}
