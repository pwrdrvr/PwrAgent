import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { normalizeAcpMcpServerConfigs, type AcpMcpServerConfig } from "@pwrdrvr/agent-acp/mcp-server-config";
import {
  ACP_PERMISSION_MODE_OPTION_ID,
  acpSessionStartMode,
  findAcpMirroredModeConfigOption,
} from "@pwragent/shared/acp-permission-mode";
import { stripAgentMemoryChunk } from "@pwragent/shared/contracts/agent-memory";
import { buildAcpAgentInstructionBlock } from "../../shared/agent-instruction-delivery.js";
import type {
  AcpBackendId,
  AppServerAvailableCommandSummary,
  AppServerPendingRequestNotification,
  AppServerThreadReplay,
  AppServerThreadMessagePart,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AcpThreadRewindPoint, GrokWorkflowBudgetPolicy } from "@pwragent/shared/contracts/agent";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendAcpRuntimeModeState,
  BackendAcpRuntimeOptionSource,
  BackendAcpSessionRuntimeState,
} from "@pwragent/shared/contracts/backend";
import {
  AcpSessionReplayNormalizer,
  acpReplayPromptTextDigest,
  acpSessionReplayNormalizerOptions,
  isAcpUserBoilerplateMessage,
  readAcpContentText,
  readAcpTopicTitle,
  readAcpUpdateTimestamp,
  type AcpSessionReplayNormalizerOptions,
  type AcpSessionUpdate,
  type AcpReplayPromptIdentity,
} from "./acp-session-normalizer.js";
import {
  acpRuntimeSupportsSessionLoad,
  acpSessionRuntimeStateFromResponse,
  acpSessionRuntimeStateFromUpdate,
  normalizeAcpRuntimeCapabilities,
} from "./acp-runtime-capabilities.js";
import { isPwrAgentGrokBuildVersion } from "./acp-agent-capabilities.js";
import {
  normalizeGrokBillingStatus,
  type AcpProviderStatus,
} from "./acp-provider-status.js";
import {
  readAcpToolCommand,
  readAcpToolContentCommand,
  readAcpToolText,
} from "./acp-command-extraction.js";
import {
  acpSessionExecutionMode,
  type AcpSessionMetadata,
  type AcpSessionStorage,
} from "@pwragent/owner-core/acp-storage";
import {
  isPwrAgentSyntheticAcpUpdate,
  type AcpRolloutRecord,
  type AcpRolloutStoreAppendParams,
} from "./acp-rollout-store.js";
import {
  foldAcpTurnUsage,
  readAcpPromptResultUsage,
  readAcpPromptResultUsageEnvelope,
  readAcpSelectedModel,
  readAcpUsageEnvelope,
  type AcpTokenUsage,
  type AcpUsageEnvelope,
} from "./acp-usage.js";
import type { JsonRpcId } from "@pwrdrvr/agent-transport";
import { getMainLogger } from "../log.js";
import {
  ACP_WORKSPACE_HANDOFF_RECORD,
  ACP_WORKSPACE_HISTORY_URI,
  acpWorkspaceContinuationText,
  acpWorkspaceHistory,
} from "./acp-workspace-history.js";

const acpClientLog = getMainLogger("pwragent:acp-client");

export type AcpJsonRpcTransport = {
  readonly disconnected?: boolean;
  disableReconnect?(): void;
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  notify?(method: string, params?: Record<string, unknown>): Promise<void>;
  close?(): Promise<void>;
  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void;
  onRequest?(
    listener: (
      method: string,
      params: Record<string, unknown>,
      id?: JsonRpcId,
    ) => Promise<unknown> | unknown,
  ): () => void;
};

const ACP_PROTOCOL_VERSION = 1;
// A turn's prompt has no deadline. The agent answers it when the turn ends,
// Stop sends session/cancel, and a dead agent process rejects every pending
// request. A wall-clock limit only abandoned turns that were still working:
// PwrAgent forgot the turn, the agent kept running and asking for approvals,
// and Stop had no turn to cancel. The transport arms a timer for every
// request, so this is the longest delay setTimeout accepts (about 24 days).
const ACP_TURN_PROMPT_REQUEST_TIMEOUT_MS = 2_147_483_647;
const ACP_CONTROL_PROMPT_REQUEST_TIMEOUT_MS = 60 * 60_000;
const ACP_TERMINAL_RESPONSE_GRACE_MS = 5_000;
const ACP_PROVIDER_STATUS_REQUEST_TIMEOUT_MS = 20_000;
const ACP_REWIND_REQUEST_TIMEOUT_MS = 20_000;
const ACP_SESSION_CLOSE_REQUEST_TIMEOUT_MS = 20_000;
/** Most sessions `closeIdleSessions` releases in one pass. */
const ACP_IDLE_SESSION_CLOSE_LIMIT = 16;

/** A session `closeIdleSessions` released, until a request reloads it. */
type AcpIdleClosedSession = {
  /** Settles when the session/close request does, whatever its outcome. */
  closed: Promise<void>;
  /** The session/load in flight, shared by every request that needs it. */
  reopening?: Promise<void>;
  /** Load succeeded, but confirming its mode and closing the worker both failed. */
  workerOpen?: boolean;
};

type AcpSessionLoadOptions = {
  suppressTranscriptReplay?: boolean;
  antigravityModeSelection?: string;
};

type AcpRuntimeOptionWrite = {
  sessionId: string;
  source: BackendAcpRuntimeOptionSource;
  optionId: string;
  value: string;
  reasoningEffort?: string;
  /** Refuse an explicit thought level the session does not offer. */
  rejectUnofferedThoughtLevel?: boolean;
  /** The owner supplied an explicit selection for Antigravity's mode option. */
  antigravityModeSession?: AcpSessionMetadata;
  /**
   * A session start's mode write: ACP session modes, or a mode config option
   * such as Antigravity's `mode` or Grok's `permission_mode`. The value came
   * from the agent's cached menu, so a mode this session's own start reply
   * does not list falls back by `acpSessionStartMode` instead of failing.
   */
  sessionStartMode?: true;
};

/** The mode selectors a session's own session/new or session/load reply listed. */
type AcpSessionModeMenu = {
  modes?: BackendAcpRuntimeModeState;
  configOptions: BackendAcpRuntimeConfigOption[];
};

// Host configurations keep record environments for process/Codex callers;
// only ACP session requests use the protocol's array-based wire type.
export type { AcpMcpServerConfig, AcpMcpServerWireConfig } from "@pwrdrvr/agent-acp/mcp-server-config";

export type AcpMcpServerRegistration = {
  servers: AcpMcpServerConfig[];
  bindThread?: (threadId: string) => Promise<void> | void;
  readListedJobMonitorCreation?: () => boolean | undefined;
  /**
   * Whether the agent's permission prompt for `toolName` on the named server
   * can be answered without the operator: PwrAgent approves that call itself
   * or the tool only reads. A registration answers only for its own servers.
   */
  hostApprovesToolCall?: (serverName: string, toolName: string) => Promise<boolean>;
};

export function mergeMcpServerRegistrations(
  ...registrations: Array<AcpMcpServerRegistration | undefined>
): AcpMcpServerRegistration {
  const present = registrations.filter(
    (registration): registration is AcpMcpServerRegistration =>
      registration !== undefined,
  );
  const approvers = present.flatMap((registration) =>
    registration.hostApprovesToolCall ? [registration.hostApprovesToolCall] : []);
  return {
    servers: present.flatMap((registration) => registration.servers),
    readListedJobMonitorCreation: present.find((entry) => entry.readListedJobMonitorCreation)?.readListedJobMonitorCreation,
    ...(approvers.length ? {
      hostApprovesToolCall: async (serverName: string, toolName: string) => {
        for (const approves of approvers) {
          if (await approves(serverName, toolName)) return true;
        }
        return false;
      },
    } : {}),
    bindThread: async (threadId) => {
      for (const registration of present) {
        await registration.bindThread?.(threadId);
      }
    },
  };
}

// Grok accepts an MCP server name only when it starts with a letter or an
// underscore and holds only letters, digits, `_` and `-`. It connects a server
// with any other name and then drops all of its tools. Custom connection IDs
// always pass. The built-in `builtin:sandboxer` does not. A rewritten name
// starts with `_`, so it cannot collide with a custom ID, which must start
// with a letter.
const ACP_MCP_SERVER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

export function acpSafeMcpServerName(name: string): string {
  if (ACP_MCP_SERVER_NAME_PATTERN.test(name)) return name;
  return `_${name.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function toAcpMcpServerWireConfigs(
  servers: readonly AcpMcpServerConfig[],
): ReturnType<typeof normalizeAcpMcpServerConfigs> {
  // Two names can rewrite to the same string (`a:b` and `a.b`). An agent
  // keeps one server per name, so give a rewritten name a numeric suffix
  // rather than let it hide another server's tools.
  const taken = new Set(servers.map((server) => server.name));
  return normalizeAcpMcpServerConfigs(servers.map((server) => {
    const safe = acpSafeMcpServerName(server.name);
    if (safe === server.name) return server;
    let name = safe;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${safe}_${suffix}`;
    taken.add(name);
    return { ...server, name };
  }));
}

/**
 * Antigravity names an MCP call `mcp_<server>_<tool>`. Returns the session
 * server and tool that name refers to, or undefined when no server, or more
 * than one, could have produced it. Antigravity may fold `-` to `_` or change
 * case, so a server matching only after folding still counts as a possible
 * source.
 */
export function resolveAntigravityMcpToolTarget(
  reportedName: string,
  serverNames: readonly string[],
): { serverName: string; toolName: string } | undefined {
  const fold = (value: string) => value.replace(/-/gu, "_").toLowerCase();
  const foldedName = fold(reportedName);
  const sources = [...new Set(serverNames)].filter((serverName) => {
    const prefix = `mcp_${fold(serverName)}_`;
    return foldedName.length > prefix.length && foldedName.startsWith(prefix);
  });
  if (sources.length !== 1) return undefined;
  const serverName = sources[0]!;
  const prefix = `mcp_${serverName}_`;
  if (!reportedName.startsWith(prefix)) return undefined;
  return { serverName, toolName: reportedName.slice(prefix.length) };
}

/**
 * The choice PwrAgent adds to an Antigravity MCP tool approval when the agent
 * offers no `allow_always`. Antigravity accepts only the options it sent, so
 * PwrAgent keeps the grant itself and answers each later call to the same
 * tool in that thread with the agent's `allow_once`.
 */
export const ACP_THREAD_TOOL_GRANT_OPTION_ID = "pwragent_allow_tool_for_thread";

type AcpSessionMcpServers = {
  /** Names as the agent received them in `session/new` or `session/load`. */
  agentNames: string[];
  /** Names a live registration can vouch for. Absent while awaiting reload. */
  registeredNames?: ReadonlySet<string>;
  hostApprovesToolCall?: AcpMcpServerRegistration["hostApprovesToolCall"];
};

export type AcpPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; resource: { uri: string; mimeType: "text/plain"; text: string } };

type AcpSessionStoreLike = Pick<
  AcpSessionStorage,
  "getSession" | "listSessions" | "upsertSession"
>;

type AcpRolloutStoreLike = {
  appendUpdate(params: AcpRolloutStoreAppendParams): void;
  flushAll?(): void;
  readUpdates(params: {
    backendId: AcpBackendId;
    sessionId: string;
  }): AcpRolloutRecord[];
};

type AcpPromptSteerHandoff = {
  nextGeneration: number;
  accept: () => void;
  reject: (error: unknown) => void;
};

type AcpActiveTurn = {
  assistantText: string;
  /** The agent compacted its history while this prompt ran. */
  compacted?: boolean;
  sentAgentMemory?: boolean;
  sentWorkspaceContext?: boolean;
  cancelBeforePrompt?: () => void;
  onTerminalUpdate?: () => void;
  terminalResponseGraceStarted?: boolean;
  turnId: string;
  promptDispatched?: boolean;
  promptGeneration: number;
  pendingSteerHandoff?: AcpPromptSteerHandoff;
};

type AcpSessionLoadState = {
  lastTimestampedTranscriptAt?: number;
  replayedTranscript: boolean;
  suppressTranscriptReplay: boolean;
  restoringAntigravityMode?: boolean;
};

type AcpSessionLoadReplay = {
  lastTimestampedTranscriptAt?: number;
};

type AcpSessionMetadataUpdateOptions = {
  touchActivity?: boolean;
};

type AcpSuppressedControlPrompt = {
  fallbackOutputText?: string;
  finalTextChunks: string[];
  model?: string;
  tokenUsage?: AcpTokenUsage;
};

type AcpHydratedSessionHistory = {
  isComplete: boolean;
  antigravityReplayPrompts?: AcpReplayPromptIdentity[];
};

export type AcpAgentClientOptions = {
  backendId: AcpBackendId;
  agentDisplayName?: string;
  antigravityFullAccess?: boolean;
  assertSessionOwner?: (sessionId: string) => void;
  initialRuntimeCapabilities?: BackendAcpRuntimeCapabilities;
  /** Bound to the launched build; vendor Grok does not implement the extension. */
  supportsTurnSteering?: boolean;
  rolloutStore?: AcpRolloutStoreLike;
  store: AcpSessionStoreLike;
  transport: AcpJsonRpcTransport;
  now?: () => number;
  onSessionStartError?: (error: unknown) => Promise<void>;
  onSessionUpdate?: (event: {
    assistantMessageItemId?: string;
    fromSessionLoad?: boolean;
    sessionId: string;
    replay: AppServerThreadReplay;
    title?: string;
    turnId?: string;
    update: Record<string, unknown>;
  }) => Promise<void> | void;
  onPromptError?: (event: {
    sessionId: string;
    turnId: string;
    error: unknown;
    usage?: AcpUsageEnvelope;
  }) => Promise<void> | void;
  onRuntimeCapabilities?: (event: {
    fromSessionLoad?: boolean;
    sessionId?: string;
    runtimeCapabilities: BackendAcpRuntimeCapabilities;
    runtimeState?: BackendAcpSessionRuntimeState;
  }) => Promise<void> | void;
  onSessionRuntimeStateChange?: (event: {
    fromSessionLoad?: boolean;
    sessionId: string;
    runtimeState: BackendAcpSessionRuntimeState;
  }) => Promise<void> | void;
  onRequest?: (
    request: AppServerPendingRequestNotification
  ) => Promise<unknown> | unknown;
  mcpServers?: (context: {
    backendId: AcpBackendId;
    cwd: string;
    runtimeCapabilities?: BackendAcpRuntimeCapabilities;
    sessionId?: string;
  }) =>
    | AcpMcpServerConfig[]
    | AcpMcpServerRegistration
    | Promise<AcpMcpServerConfig[] | AcpMcpServerRegistration>;
  /**
   * Names the agent tool catalog the MCP servers advertise now. An agent
   * lists a session's tools once, when session/new or session/load starts
   * its servers, so a session set up under another key is reloaded before
   * its next prompt.
   */
  agentToolCatalogKey?: () => string;
  readJobMonitorCreationPreference?: (sessionId?: string) => Promise<boolean>;
  onJobMonitorControlReady?: (sessionId: string) => Promise<void>;
};

type AcpJobMonitorCatalog = {
  enabled: boolean;
  readListed: () => boolean | undefined;
  fromLoad: boolean;
};

export class AcpAgentClient {
  private readonly normalizers = new Map<string, AcpSessionReplayNormalizer>();
  private readonly jobMonitorCatalogs = new Map<string, AcpJobMonitorCatalog>();
  private readonly grokBackgroundSessions = new Set<string>();
  private readonly antigravityBackgroundCommands = new Map<string, Set<string>>();
  private readonly activeTurns = new Map<string, AcpActiveTurn>();
  private readonly loadedSessionCwds = new Map<string, string | undefined>();
  private readonly antigravityPrimaryCwds = new Map<string, string>();
  // The option menus each session's own latest reply reported, by protocol
  // session id. On Kimi the model decides which thought levels exist and the
  // agent refuses any other, so a level is checked against its session's menu,
  // never the client-wide snapshot, which is whichever session wrote last.
  private readonly sessionConfigOptions = new Map<
    string,
    BackendAcpRuntimeConfigOption[]
  >();
  // The mode selectors each session's own session/new or session/load reply
  // listed, by protocol session id. Unlike `sessionConfigOptions`, a later
  // reply without a menu leaves this alone: a start writes its model before
  // its mode, and the model write's reply need not repeat the mode menu.
  private readonly sessionModeMenus = new Map<string, AcpSessionModeMenu>();
  private readonly suppressedControlPromptSessions = new Map<
    string,
    AcpSuppressedControlPrompt
  >();
  private readonly loadingSessions = new Map<string, AcpSessionLoadState>();
  private readonly sessionLoadReplays = new Map<string, AcpSessionLoadReplay>();
  private readonly agentSessionIdsByAppSessionId = new Map<string, string>();
  private readonly appSessionIdsByAgentSessionId = new Map<string, string>();
  private readonly retainableSessionIds = new Set<string>();
  /**
   * When each session last saw a request, an update or a permission request,
   * by app session id. An ACP agent keeps a session's MCP servers running
   * until session/close, so `closeIdleSessions` releases quiet ones.
   */
  private readonly sessionLastActivityAt = new Map<string, number>();
  /**
   * The context fill each session last reported live in `usage_update`, with
   * the agent session that reported it: a thread bound to a new agent session
   * starts a new baseline.
   */
  private readonly sessionContextFill = new Map<
    string,
    { protocolSessionId: string; used: number }
  >();
  /** Permission requests the agent is waiting on, by app session id. */
  private readonly pendingPermissionRequests = new Map<string, number>();
  /**
   * Sessions that must load before the next request. An Antigravity worker
   * can still be open here if mode confirmation and cleanup both failed.
   */
  private readonly idleClosedSessions = new Map<string, AcpIdleClosedSession>();
  /**
   * Helper sessions that session/load cannot rebuild as they were created:
   * session/new carried an agent profile in `_meta`, or no MCP servers, and
   * session/load would bring back neither. They are never idle-closed.
   */
  private readonly sessionsWithoutFaithfulReload = new Set<string>();
  /** The `agentToolCatalogKey` each session's MCP servers started under, by app session id. */
  private readonly sessionAgentToolCatalogKeys = new Map<string, string>();
  /** The MCP servers each session's agent last received. */
  private readonly sessionMcpServers = new Map<string, AcpSessionMcpServers>();
  /** MCP tools the operator allowed for the rest of a thread. */
  private readonly sessionMcpToolGrants = new Map<string, Set<string>>();
  private readonly now: () => number;
  private readonly approvalRequesterName: string;
  private unsubscribe?: () => void;
  private unsubscribeRequest?: () => void;
  private runtimeCapabilities?: BackendAcpRuntimeCapabilities;
  private archiveRestoreSupported = false;
  private antigravitySessionListSupported = false;
  private jobMonitorCatalogRefreshSupported = false;
  private readonly normalizerOptions: AcpSessionReplayNormalizerOptions;
  private activeOperations = 0;

  constructor(private readonly options: AcpAgentClientOptions) {
    // Initialization and loaded sessions belong to one child. The client
    // owner must create a fresh client if that child disconnects.
    options.transport.disableReconnect?.();
    this.now = options.now ?? Date.now;
    this.runtimeCapabilities = options.initialRuntimeCapabilities;
    this.approvalRequesterName = approvalRequesterNameForOptions(options);
    this.normalizerOptions = acpSessionReplayNormalizerOptions(options.backendId);
  }

  get disconnected(): boolean {
    return this.options.transport.disconnected === true;
  }

  async initialize(): Promise<void> {
    this.unsubscribe = this.options.transport.onNotification((method, params) => {
      if (method === "session/update") {
        this.applySessionUpdate(params);
        return;
      }
      // Grok's vendor notification carries the auto-generated session
      // summary at the end of the first turn. Its envelope shape matches
      // session/update (`{ sessionId, update: { sessionUpdate, ... } }`), so
      // the same dispatch path handles it — readAcpTopicTitle picks the
      // title out of the "session_summary_generated" kind, and the
      // normalizer treats the inner update as thread metadata rather than
      // a transcript entry (see acp-session-normalizer.ts:118).
      if (method === "_x.ai/session_notification") {
        // Log the raw shape at debug so a future Grok CLI release that
        // renames the kind or moves the title field surfaces visibly
        // instead of silently degrading to "ACP session" forever. Kept
        // off the info channel because this fires once per turn-end.
        const update = (params as { update?: { sessionUpdate?: string } })
          .update;
        acpClientLog.debug("grok vendor notification", {
          backendId: this.options.backendId,
          sessionUpdate: update?.sessionUpdate,
          hasSummary: Boolean(
            (update as { session_summary?: string } | undefined)
              ?.session_summary?.trim()
              || (update as { sessionSummary?: string } | undefined)
                ?.sessionSummary?.trim(),
          ),
        });
        this.applySessionUpdate(params);
      }
    });
    this.unsubscribeRequest = this.options.transport.onRequest?.(
      async (method, params, id) => await this.handleAcpRequest(method, params, id),
    );
    const result = await this.options.transport.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        auth: {
          terminal: false,
        },
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
      clientInfo: {
        name: "pwragent",
        title: "PwrAgent",
        version: "0.0.0",
      },
    });
    // Destructive archive eligibility must use this process's advertisement,
    // rather than inheriting a cached capability from an older executable.
    const advertised = normalizeAcpRuntimeCapabilities({
      value: result, now: this.now(), source: "initialize",
    })?.agentCapabilities;
    const rawCapabilities = asRecord(advertised?.raw);
    const sessionCapabilities = asRecord(rawCapabilities?.sessionCapabilities ?? rawCapabilities?.session_capabilities);
    this.antigravitySessionListSupported = Boolean(asRecord(sessionCapabilities?.list));
    this.archiveRestoreSupported = advertised?.loadSession === true;
    this.jobMonitorCatalogRefreshSupported = advertised?.loadSession === true
      && advertised.session?.close === true && advertised.mcp?.http === true;
    const runtimeCapabilities = this.captureRuntimeCapabilities({
      source: "initialize",
      result,
    });
    this.notifyRuntimeCapabilities({
      runtimeCapabilities,
    });
  }

  hasActiveTurns(): boolean {
    return this.activeTurns.size > 0;
  }

  hasActiveOperations(): boolean {
    return this.activeOperations > 0;
  }

  ownsSession(sessionId: string): boolean {
    return this.agentSessionIdsByAppSessionId.has(sessionId);
  }

  hasRetainableSessions(): boolean {
    return this.retainableSessionIds.size > 0;
  }

  supportsSessionLoad(): boolean {
    return acpRuntimeSupportsSessionLoad(this.runtimeCapabilities);
  }

  supportsArchivedSessionRestore(): boolean {
    return this.archiveRestoreSupported;
  }

  /** Release just this session; never cancel another session on the process. */
  async closeSessionForArchive(sessionId: string): Promise<boolean> {
    this.options.assertSessionOwner?.(sessionId);
    if (this.activeTurns.has(sessionId) || this.hasActiveOperations()) {
      throw new Error("An ACP operation is still active; the checkout was kept.");
    }
    return await this.closeOwnedSession(sessionId);
  }

  async closeSessionForTransfer(sessionId: string): Promise<void> {
    if (this.activeTurns.has(sessionId) || this.hasActiveOperations() || this.hasNativeBackgroundWork(sessionId)) {
      throw new Error("Wait for Antigravity's active work to finish before moving the session.");
    }
    if (!await this.closeOwnedSession(sessionId, true)) {
      throw new Error("This Antigravity runtime cannot close the session for transfer.");
    }
    this.normalizers.delete(sessionId);
  }

  private async closeOwnedSession(sessionId: string, retainMcpGrants = false): Promise<boolean> {
    const protocolSessionId = this.agentSessionIdsByAppSessionId.get(sessionId);
    if (!protocolSessionId) return true;
    if (!this.supportsSessionClose()) return false;
    return await this.withOperation(async () => {
      const idleClosed = this.idleClosedSessions.get(sessionId);
      await idleClosed?.closed;
      // An idle close already released it, unless a request reloaded it.
      if (!idleClosed || idleClosed.workerOpen || this.idleClosedSessions.get(sessionId) !== idleClosed) {
        await this.options.transport.request("session/close", { sessionId: protocolSessionId });
      }
      this.loadedSessionCwds.delete(protocolSessionId);
      this.sessionLoadReplays.delete(protocolSessionId);
      this.sessionConfigOptions.delete(protocolSessionId);
      this.sessionModeMenus.delete(protocolSessionId);
      this.agentSessionIdsByAppSessionId.delete(sessionId);
      this.appSessionIdsByAgentSessionId.delete(protocolSessionId);
      this.retainableSessionIds.delete(sessionId);
      this.forgetSessionActivity(sessionId, retainMcpGrants);
      return true;
    });
  }

  private supportsSessionClose(): boolean {
    return this.runtimeCapabilities?.agentCapabilities?.session?.close === true;
  }

  supportsJobMonitorControl(sessionId: string): boolean {
    return this.jobMonitorCatalogRefreshSupported && this.jobMonitorCatalogs.has(sessionId);
  }

  /**
   * Close sessions nothing has used for `idleMs`, so the agent stops their
   * MCP servers. An ACP agent keeps every session it created or loaded open
   * until session/close; before this, one Grok process held 39 PwrAgent MCP
   * bridges after a day.
   *
   * Only an agent that advertises both session/close and session/load
   * qualifies, since the next request must reload the session. A session
   * stays open while it runs a turn or a control prompt, loads, waits on a
   * permission request, or `isSessionBusy` (the owner's view: queued input,
   * reserved turns) says so, and the whole pass is skipped while another
   * operation is in flight. The session keeps its routing and in-memory
   * transcript; the next request for it runs session/load first.
   */
  async closeIdleSessions(params: {
    idleMs: number;
    isSessionBusy?: (sessionId: string) => boolean;
    limit?: number;
  }): Promise<string[]> {
    if (
      !this.supportsSessionClose()
      || !this.supportsSessionLoad()
      || this.hasActiveOperations()
    ) {
      return [];
    }
    const isIdle = (sessionId: string): boolean =>
      this.sessionIsIdle(sessionId, params.idleMs)
      && params.isSessionBusy?.(sessionId) !== true;
    const candidates = [...this.loadedSessionCwds.keys()]
      .map((protocolSessionId) => this.appSessionIdFor(protocolSessionId))
      .filter(isIdle)
      .slice(0, params.limit ?? ACP_IDLE_SESSION_CLOSE_LIMIT);
    if (candidates.length === 0) return [];
    const closed = await this.withOperation(async () => {
      const released: string[] = [];
      for (const sessionId of candidates) {
        // A request may have touched it while an earlier close ran.
        if (!isIdle(sessionId)) continue;
        if (await this.closeIdleSession(sessionId)) released.push(sessionId);
      }
      return released;
    });
    if (closed.length > 0) {
      acpClientLog.info("closed idle ACP sessions", {
        backendId: this.options.backendId,
        count: closed.length,
        stillOpen: this.loadedSessionCwds.size,
      });
    }
    return closed;
  }

  private sessionIsIdle(sessionId: string, idleMs: number): boolean {
    const protocolSessionId = this.agentSessionIdsByAppSessionId.get(sessionId) ?? sessionId;
    const idleClosed = this.idleClosedSessions.get(sessionId);
    if (
      !this.loadedSessionCwds.has(protocolSessionId)
      || (idleClosed && !idleClosed.workerOpen)
      || this.sessionsWithoutFaithfulReload.has(sessionId)
      || this.activeTurns.has(sessionId)
      || this.pendingPermissionRequests.has(sessionId)
      || this.loadingSessions.has(protocolSessionId)
      || this.suppressedControlPromptSessions.has(protocolSessionId)
      || this.hasNativeBackgroundWork(sessionId)
    ) {
      return false;
    }
    const lastActiveAt = this.sessionLastActivityAt.get(sessionId);
    if (lastActiveAt === undefined) {
      // Loaded before tracking saw it; start its clock now.
      this.touchSession(sessionId);
      return false;
    }
    return this.now() - lastActiveAt >= idleMs;
  }

  private async closeIdleSession(sessionId: string): Promise<boolean> {
    const protocolSessionId = this.protocolSessionIdFor(sessionId);
    const cwd = this.loadedSessionCwds.get(protocolSessionId);
    const previouslyUnconfirmed = this.idleClosedSessions.get(sessionId);
    // Mark it closed before the request, so a request that starts meanwhile
    // waits for the close and then reloads the session.
    let settle!: () => void;
    const idleClosed: AcpIdleClosedSession = {
      closed: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    this.loadedSessionCwds.delete(protocolSessionId);
    this.idleClosedSessions.set(sessionId, idleClosed);
    try {
      await this.options.transport.request(
        "session/close",
        { sessionId: protocolSessionId },
        ACP_SESSION_CLOSE_REQUEST_TIMEOUT_MS,
      );
      this.sessionLastActivityAt.delete(sessionId);
      return true;
    } catch (error) {
      // The agent may still hold the session; keep treating it as loaded.
      if (this.idleClosedSessions.get(sessionId) === idleClosed) {
        if (previouslyUnconfirmed) this.idleClosedSessions.set(sessionId, previouslyUnconfirmed);
        else this.idleClosedSessions.delete(sessionId);
        this.loadedSessionCwds.set(protocolSessionId, cwd);
        this.touchSession(sessionId);
      }
      acpClientLog.warn("idle ACP session close failed", {
        backendId: this.options.backendId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      settle();
    }
  }

  /**
   * Reload a session `closeIdleSessions` released, before a request uses it.
   * The in-memory transcript is still current, so the replay session/load
   * sends is dropped unless the caller asks for it.
   */
  private async reopenIdleClosedSession(
    sessionId: string,
    options: AcpSessionLoadOptions & { metadata?: AcpSessionMetadata } = {},
  ): Promise<void> {
    const idleClosed = this.idleClosedSessions.get(sessionId);
    if (!idleClosed) return;
    if (idleClosed.reopening && options.antigravityModeSelection !== undefined) {
      // An ordinary reload might still be trying the mode being replaced.
      await idleClosed.reopening.catch(() => undefined);
      await this.reopenIdleClosedSession(sessionId, options);
      return;
    }
    if (!idleClosed.reopening) {
      const reopening = (async () => {
        await idleClosed.closed;
        // The close failed, or the session was archived meanwhile.
        if (this.idleClosedSessions.get(sessionId) !== idleClosed) {
          if (options.antigravityModeSelection !== undefined) {
            await this.reopenIdleClosedSession(sessionId, options);
          }
          return;
        }
        const metadata =
          options.metadata
          ?? this.options.store.getSession(this.options.backendId, sessionId);
        if (!metadata) {
          throw new Error(`ACP session not found: ${sessionId}`);
        }
        await this.loadSessionFromAgent(metadata, {
          antigravityModeSelection: options.antigravityModeSelection,
          suppressTranscriptReplay: options.suppressTranscriptReplay ?? true,
        });
        if (this.idleClosedSessions.get(sessionId) === idleClosed) {
          this.idleClosedSessions.delete(sessionId);
        }
        this.touchSession(sessionId);
      })();
      idleClosed.reopening = reopening;
      // A failed load leaves the session unready; the next request retries.
      reopening.catch(() => {
        if (idleClosed.reopening === reopening) idleClosed.reopening = undefined;
      });
    }
    await idleClosed.reopening;
  }

  /**
   * Record a request about to use this session. Returns the reload to await
   * first when the session was idle-closed, and nothing otherwise, so a
   * request for an open session still goes out synchronously.
   */
  private reloadBeforeRequest(sessionId: string): Promise<void> | undefined {
    this.options.assertSessionOwner?.(sessionId);
    this.touchSession(sessionId);
    return this.idleClosedSessions.has(sessionId)
      ? this.reopenIdleClosedSession(sessionId)
      : undefined;
  }

  private touchSession(sessionId: string): void {
    this.sessionLastActivityAt.set(sessionId, this.now());
  }

  private forgetSessionActivity(sessionId: string, retainMcpGrants: boolean): void {
    this.sessionLastActivityAt.delete(sessionId);
    this.sessionContextFill.delete(sessionId);
    this.idleClosedSessions.delete(sessionId);
    this.pendingPermissionRequests.delete(sessionId);
    this.sessionsWithoutFaithfulReload.delete(sessionId);
    this.sessionAgentToolCatalogKeys.delete(sessionId);
    const previousMcpServers = this.sessionMcpServers.get(sessionId);
    if (retainMcpGrants && previousMcpServers && this.sessionMcpToolGrants.has(sessionId)) {
      // Keep the names for reload validation, without the closed worker's
      // live tool registration.
      this.sessionMcpServers.set(sessionId, { agentNames: previousMcpServers.agentNames });
    } else {
      this.sessionMcpServers.delete(sessionId);
      this.sessionMcpToolGrants.delete(sessionId);
    }
    this.jobMonitorCatalogs.delete(sessionId);
    this.grokBackgroundSessions.delete(sessionId);
    this.antigravityBackgroundCommands.delete(sessionId);
  }

  supportsTurnSteering(): boolean {
    if (this.options.backendId === "acp:antigravity") {
      return this.options.supportsTurnSteering !== false;
    }
    return this.options.backendId === "acp:grok"
      && (this.options.supportsTurnSteering === true
        || isPwrAgentGrokBuildVersion(this.runtimeCapabilities?.agentInfo?.version));
  }

  // Count the whole public operation, including setup before the transport
  // request and state updates after it, so launch replacement cannot dispose
  // this client at either edge of an in-flight RPC.
  private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
    }
  }

  async dispose(): Promise<void> {
    this.options.rolloutStore?.flushAll?.();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeRequest?.();
    this.unsubscribeRequest = undefined;
    this.agentSessionIdsByAppSessionId.clear();
    this.appSessionIdsByAgentSessionId.clear();
    this.retainableSessionIds.clear();
    this.loadedSessionCwds.clear();
    this.antigravityPrimaryCwds.clear();
    this.sessionConfigOptions.clear();
    this.sessionModeMenus.clear();
    this.sessionLastActivityAt.clear();
    this.sessionContextFill.clear();
    this.pendingPermissionRequests.clear();
    this.idleClosedSessions.clear();
    this.sessionsWithoutFaithfulReload.clear();
    this.jobMonitorCatalogs.clear();
    this.grokBackgroundSessions.clear();
    this.antigravityBackgroundCommands.clear();
    this.sessionAgentToolCatalogKeys.clear();
    this.sessionMcpServers.clear();
    this.sessionMcpToolGrants.clear();
    await this.options.transport.close?.();
  }

  async readProviderStatus(): Promise<AcpProviderStatus | undefined> {
    return await this.withOperation(
      async () => await this.readProviderStatusOperation(),
    );
  }

  private async readProviderStatusOperation(): Promise<
    AcpProviderStatus | undefined
  > {
    if (this.options.backendId !== "acp:grok") {
      return undefined;
    }
    // ACP serializes extension methods with a leading underscore on the wire.
    // Grok's internal ExtRequest names this `x.ai/billing`, but stdio clients
    // must send `_x.ai/billing`.
    const result = await this.options.transport.request(
      "_x.ai/billing",
      {},
      ACP_PROVIDER_STATUS_REQUEST_TIMEOUT_MS,
    );
    return normalizeGrokBillingStatus(result);
  }

  async listRewindPoints(sessionId: string): Promise<AcpThreadRewindPoint[]> {
    return await this.withOperation(async () => {
      const reload = this.reloadBeforeRequest(sessionId);
      if (reload) await reload;
      const protocolSessionId = this.protocolSessionIdFor(sessionId);
      const result = asRecord(await this.options.transport.request(
        "_x.ai/rewind/points",
        { sessionId: protocolSessionId },
        ACP_REWIND_REQUEST_TIMEOUT_MS,
      ));
      const points = Array.isArray(result?.rewind_points)
        ? result.rewind_points
        : Array.isArray(result?.rewindPoints)
          ? result.rewindPoints
          : [];
      return points.flatMap((value) => {
        const point = asRecord(value);
        const promptIndex = readFiniteNumber(point, "prompt_index")
          ?? readFiniteNumber(point, "promptIndex");
        if (promptIndex === undefined || !Number.isInteger(promptIndex)) {
          return [];
        }
        const createdAtValue = point?.created_at ?? point?.createdAt;
        const createdAt = normalizeRewindTimestamp(createdAtValue);
        return [{
          promptIndex,
          ...(createdAt !== undefined ? { createdAt } : {}),
          fileSnapshotCount:
            readFiniteNumber(point, "num_file_snapshots")
            ?? readFiniteNumber(point, "fileSnapshotCount")
            ?? 0,
          hasFileChanges:
            readBooleanValue(point, "has_file_changes")
            ?? readBooleanValue(point, "hasFileChanges")
            ?? false,
          promptPreview:
            readStringValue(point, "prompt_preview")
            ?? readStringValue(point, "promptPreview")
            ?? `Prompt ${promptIndex + 1}`,
        }];
      });
    });
  }

  async rewindSession(params: {
    sessionId: string;
    targetPromptIndex: number;
  }): Promise<{ promptText?: string; updatedAt: number }> {
    return await this.withOperation(async () => {
      const reload = this.reloadBeforeRequest(params.sessionId);
      if (reload) await reload;
      const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
      const result = asRecord(await this.options.transport.request(
        "_x.ai/rewind/execute",
        {
          sessionId: protocolSessionId,
          targetPromptIndex: params.targetPromptIndex,
          force: true,
          mode: "conversation_only",
        },
        ACP_REWIND_REQUEST_TIMEOUT_MS,
      ));
      if (readBooleanValue(result, "success") !== true) {
        throw new Error(
          readStringValue(result, "error") ?? "Grok could not rewind this conversation",
        );
      }
      this.normalizerFor(params.sessionId).rewindToPromptIndex(
        params.targetPromptIndex,
        { missingTarget: "clear" },
      );
      const receivedAt = this.now();
      this.appendHistoryUpdate(params.sessionId, receivedAt, {
        kind: "pwragent_rewind_marker",
        targetPromptIndex: params.targetPromptIndex,
      });
      this.updateSessionStatus(params.sessionId, "idle", receivedAt);
      return {
        updatedAt: receivedAt,
        promptText:
          readStringValue(result, "prompt_text")
          ?? readStringValue(result, "promptText"),
      };
    });
  }

  async steerSession(params: {
    sessionId: string;
    text: string;
    prompt?: string;
    parts?: AppServerThreadMessagePart[];
    content: AcpPromptContentBlock[];
    interjectionId: string;
  }): Promise<{ delivery: "currentTurn" | "nextTurn" }> {
    if (!this.supportsTurnSteering()) {
      throw new Error(
        this.options.backendId === "acp:antigravity"
          ? "Installed Antigravity CLI does not support turn steering over ACP"
          : "Installed Grok Build does not support turn steering over ACP",
      );
    }
    if (this.options.backendId === "acp:antigravity") {
      return await this.withOperation(
        async () => await this.steerAntigravitySession(params),
      );
    }
    return await this.withOperation(async () => {
      const reload = this.reloadBeforeRequest(params.sessionId);
      if (reload) await reload;
      const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
      const response = asRecord(await this.options.transport.request(
        "_x.ai/session/steer",
        {
          sessionId: protocolSessionId,
          text: params.text,
          interjectionId: params.interjectionId,
          content: params.content,
        },
        ACP_REWIND_REQUEST_TIMEOUT_MS,
      ));
      const result = asRecord(response?.result) ?? response;
      const delivery = readStringValue(result, "delivery");
      if (delivery !== "currentTurn" && delivery !== "nextTurn") {
        throw new Error("Grok steering response did not identify its delivery turn");
      }
      return { delivery };
    });
  }

  /**
   * Antigravity (`agy acp`) steers a running turn by accepting a concurrent
   * `session/prompt`: it immediately detaches the in-flight prompt with
   * `{ stopReason: "end_turn" }` and transfers the active turn stream to the
   * new prompt request. When steering is rejected (for example while waiting on
   * a permission or question answer), the new prompt rejects and the original
   * prompt keeps running undisturbed.
   */
  private async steerAntigravitySession(params: {
    sessionId: string;
    text: string;
    prompt?: string;
    parts?: AppServerThreadMessagePart[];
    content: AcpPromptContentBlock[];
    interjectionId: string;
  }): Promise<{ delivery: "currentTurn" }> {
    const activeTurn = this.activeTurns.get(params.sessionId);
    if (!activeTurn || !activeTurn.promptDispatched) {
      throw new Error("The Antigravity turn finished before steering was accepted");
    }
    if (activeTurn.pendingSteerHandoff) {
      throw new Error("Another Antigravity steering request is already in flight");
    }
    const nextGeneration = activeTurn.promptGeneration + 1;
    const messageId = `user:${activeTurn.turnId}:steer:${params.interjectionId}`;
    const displayPrompt = params.prompt ?? params.text;
    const handoff = Promise.withResolvers<void>();
    let nextPromptSettled = false;

    const adoptSteer = (): void => {
      // This receipt describes provider acceptance. The history write can
      // fail after ownership has already moved to the replacement prompt.
      handoff.resolve();
      const receivedAt = this.now();
      const replay = this.normalizerFor(params.sessionId).recordSteeredUserPrompt({
        sessionId: params.sessionId,
        messageId,
        prompt: displayPrompt,
        parts: params.parts,
        turnId: activeTurn.turnId,
        receivedAt,
      });
      const update: Record<string, unknown> = {
        kind: "pwragent_steered_user_prompt",
        messageId,
        prompt: displayPrompt,
        ...(params.parts?.length ? { parts: params.parts } : {}),
        turnId: activeTurn.turnId,
        createdAt: receivedAt,
      };
      try {
        this.appendHistoryUpdate(params.sessionId, receivedAt, update);
        this.markSessionHasConversationHistory(params.sessionId, receivedAt);
      } catch (error) {
        acpClientLog.warn("Could not persist accepted Antigravity steering message", {
          sessionId: params.sessionId,
          turnId: activeTurn.turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      void this.notifySessionUpdate({
        sessionId: params.sessionId,
        replay,
        turnId: activeTurn.turnId,
        update,
      });
    };

    activeTurn.pendingSteerHandoff = {
      nextGeneration,
      accept: adoptSteer,
      reject: (error) => {
        if (!nextPromptSettled && !this.disconnected) {
          void this.cancelSessionOperation(params.sessionId).catch(() => undefined);
        }
        handoff.reject(error);
      },
    };

    let nextPrompt: Promise<unknown>;
    try {
      this.assertPromptAccess(params.sessionId);
      const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
      nextPrompt = this.options.transport.request(
        "session/prompt",
        {
          sessionId: protocolSessionId,
          prompt: params.content,
        },
        ACP_TURN_PROMPT_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      if (activeTurn.pendingSteerHandoff?.nextGeneration === nextGeneration) {
        activeTurn.pendingSteerHandoff = undefined;
      }
      throw error;
    }

    void nextPrompt.then(
      () => {
        nextPromptSettled = true;
      },
      (error) => {
        nextPromptSettled = true;
        if (activeTurn.pendingSteerHandoff?.nextGeneration === nextGeneration) {
          activeTurn.pendingSteerHandoff = undefined;
          handoff.reject(error);
        }
      },
    );
    // A successful overlapping request alone does not show that it took
    // over this turn. Observe its lifecycle only after the displaced prompt
    // confirms that the replacement owns the turn.
    void handoff.promise.then(() => {
      this.observeActiveTurnPrompt({
        sessionId: params.sessionId,
        activeTurn,
        generation: nextGeneration,
        promptPromise: nextPrompt,
      });
    }, () => undefined);

    await handoff.promise;
    return { delivery: "currentTurn" };
  }

  async configureWorkflowBudget(params: {
    sessionId: string;
    defaultAgentBudget?: number;
    maxAgentBudget?: number;
  }): Promise<GrokWorkflowBudgetPolicy> {
    return await this.withOperation(async () => {
      const reload = this.reloadBeforeRequest(params.sessionId);
      if (reload) await reload;
      const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
      const response = asRecord(await this.options.transport.request(
        "_x.ai/session/workflow_budget",
        {
          sessionId: protocolSessionId,
          ...(params.defaultAgentBudget !== undefined
            ? { defaultAgentBudget: params.defaultAgentBudget }
            : {}),
          ...(params.maxAgentBudget !== undefined
            ? { maxAgentBudget: params.maxAgentBudget }
            : {}),
        },
        ACP_REWIND_REQUEST_TIMEOUT_MS,
      ));
      const result = asRecord(response?.result) ?? response;
      const defaultAgentBudget = readFiniteNumber(result, "defaultAgentBudget");
      const maxAgentBudget = readFiniteNumber(result, "maxAgentBudget");
      if (
        defaultAgentBudget === undefined
        || maxAgentBudget === undefined
        || !Number.isInteger(defaultAgentBudget)
        || !Number.isInteger(maxAgentBudget)
      ) {
        throw new Error("Grok workflow-budget response was invalid");
      }
      return { defaultAgentBudget, maxAgentBudget };
    });
  }

  async startSession(params: {
    sessionId?: string;
    cwd?: string;
    executionMode: ThreadExecutionMode;
    approvalPolicy?: "deny-all";
    title?: string;
    createdAt?: number;
    acpRuntime?: BackendAcpSessionRuntimeState;
    hidden?: boolean;
    mcpServers?: "default" | "none";
    additionalMcpRegistration?: AcpMcpServerRegistration;
    sessionMeta?: Record<string, unknown>;
    workspaceHandoff?: {
      replay: AppServerThreadReplay;
      previousAgentSessionId?: string;
      mode?: string;
      titleSource?: AcpSessionMetadata["titleSource"];
    };
  }): Promise<AcpSessionMetadata> {
    return await this.withOperation(
      async () => await this.startSessionOperation(params),
    );
  }

  private async startSessionOperation(
    params: Parameters<AcpAgentClient["startSession"]>[0],
  ): Promise<AcpSessionMetadata> {
    if (params.sessionId) this.options.assertSessionOwner?.(params.sessionId);
    if (this.options.antigravityFullAccess !== undefined
      && this.options.antigravityFullAccess !== (params.executionMode === "full-access")) {
      throw new Error("The Antigravity process does not match the new thread's access.");
    }
    const handoff = params.workspaceHandoff;
    const rolloutStore = this.options.rolloutStore;
    if (handoff && !rolloutStore) throw new Error("The ACP rollout store is unavailable for workspace handoff.");
    const cwd = params.cwd ?? process.cwd();
    // Read before the servers are built, so a change meanwhile reads as stale.
    const agentToolCatalogKey = this.options.agentToolCatalogKey?.();
    const jobMonitorCreationEnabled = this.jobMonitorCatalogRefreshSupported
      ? await this.options.readJobMonitorCreationPreference?.(params.sessionId) : undefined;
    const defaultMcpRegistration =
      params.mcpServers === "none"
        ? { servers: [] }
        : await this.buildMcpServers({
            cwd,
            sessionId: params.sessionId,
          });
    const mcpRegistration = mergeMcpServerRegistrations(
      defaultMcpRegistration,
      params.additionalMcpRegistration,
    );
    const mcpServerWireConfigs = toAcpMcpServerWireConfigs(mcpRegistration.servers);
    let result = await this.options.transport.request("session/new", {
      cwd,
      mcpServers: mcpServerWireConfigs,
      ...(params.sessionMeta ? { _meta: params.sessionMeta } : {}),
    }).catch(async (error: unknown) => {
      // A failed publication must never replace the provider's error.
      await this.options.onSessionStartError?.(error).catch(() => undefined);
      throw error;
    });
    const now = this.now();
    const record = asRecord(result);
    const sessionId =
      typeof record?.sessionId === "string"
        ? record.sessionId
        : typeof record?.session_id === "string"
          ? record.session_id
          : undefined;
    if (!sessionId) {
      throw new Error("ACP session/new did not return a session id");
    }
    const appSessionId = params.sessionId ?? sessionId;
    if (handoff && rolloutStore) {
      try {
        if (handoff.mode) {
          result = await this.confirmAntigravityMode(sessionId, result, handoff.mode, true);
        }
        rolloutStore.appendUpdate({
          backendId: this.options.backendId,
          sessionId: appSessionId,
          receivedAt: now,
          update: {
            kind: ACP_WORKSPACE_HANDOFF_RECORD, agentSessionId: sessionId,
            previousAgentSessionId: handoff.previousAgentSessionId,
            replay: handoff.replay,
          },
        });
      } catch (error) {
        await this.options.transport.request("session/close", { sessionId }, ACP_SESSION_CLOSE_REQUEST_TIMEOUT_MS)
          .catch((closeError: unknown) => acpClientLog.warn("Could not close an unbound Antigravity workspace session", {
            sessionId, error: closeError instanceof Error ? closeError.message : String(closeError),
          }));
        throw error;
      }
    }
    const runtimeCapabilities = this.captureRuntimeCapabilities({ source: "session-new", result });
    const runtimeState = this.runtimeStateFromResponse(result, now);
    const combinedRuntimeState =
      params.acpRuntime || runtimeState
        ? mergeAcpRuntimeState(params.acpRuntime, runtimeState ?? {})
        : undefined;
    const metadata: AcpSessionMetadata = {
      backendId: this.options.backendId,
      sessionId: appSessionId,
      ...(sessionId === appSessionId ? {} : { agentSessionId: sessionId }),
      title: params.title ?? "ACP session",
      titleSource: handoff?.titleSource ?? (params.title ? "explicit" : "fallback"),
      cwd,
      createdAt: params.createdAt ?? now,
      updatedAt: now,
      executionMode: params.executionMode,
      ...(this.options.antigravityFullAccess === true ? { antigravityFullAccessConfirmed: true } : {}),
      ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
      acpRuntime: combinedRuntimeState,
      ...(params.hidden ? { hidden: true } : {}),
      ...(this.options.backendId === "acp:antigravity" ? { antigravityPrimaryCwd: cwd } : {}),
      ...(handoff ? { antigravityWorkspaceRebound: true } : {}),
      status: "idle",
    };
    this.options.store.upsertSession(metadata);
    this.rememberSessionIds(metadata);
    // An update that arrived before session/new answered made the session's
    // normalizer without a workspace.
    this.normalizers.get(appSessionId)?.setWorkspace(cwd);
    this.loadedSessionCwds.set(sessionId, cwd);
    this.touchSession(appSessionId);
    if (params.sessionMeta || params.mcpServers === "none") {
      this.sessionsWithoutFaithfulReload.add(appSessionId);
    }
    if (!params.hidden && !this.sessionsWithoutFaithfulReload.has(appSessionId)) {
      this.rememberJobMonitorCatalog(appSessionId, mcpRegistration, jobMonitorCreationEnabled, false);
    }
    this.rememberAgentToolCatalogKey(appSessionId, agentToolCatalogKey);
    this.rememberSessionMcpServers(appSessionId, mcpRegistration, mcpServerWireConfigs);
    this.rememberSessionConfigOptions(sessionId, result);
    this.rememberSessionModeMenu(sessionId, result);
    await Promise.resolve(mcpRegistration.bindThread?.(appSessionId));
    this.notifyRuntimeCapabilities({
      sessionId: appSessionId,
      runtimeCapabilities,
      runtimeState,
    });
    return metadata;
  }

  async prompt(params: {
    sessionId: string;
    prompt: string;
    promptContent?: AcpPromptContentBlock[];
    parts?: AppServerThreadMessagePart[];
  }): Promise<{ sessionId: string; turnId: string }> {
    const turnId = `pending:${params.sessionId}:${this.now()}`;
    const receivedAt = this.now();
    this.startTrackedTurn(params.sessionId, turnId);
    this.normalizerFor(params.sessionId).recordUserPrompt({
      sessionId: params.sessionId,
      prompt: params.prompt,
      parts: params.parts,
      turnId,
      receivedAt,
      waitingForAgent: true,
    });
    this.appendHistoryUpdate(params.sessionId, receivedAt, {
      kind: "pwragent_user_prompt",
      prompt: params.prompt,
      ...(params.parts?.length ? { parts: params.parts } : {}),
      turnId,
      waitingForAgent: true,
    });
    this.markSessionHasConversationHistory(params.sessionId, receivedAt);
    let result: unknown;
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    try {
      const promptRequest = this.requestPromptWithTerminalGuard({
        protocolSessionId,
        prompt: params.promptContent ?? textPrompt(params.prompt),
        sessionId: params.sessionId,
        turnId,
      });
      result = await promptRequest;
      const responseError = this.missingPromptResponseError(params.sessionId, result);
      if (responseError) {
        throw responseError;
      }
    } catch (error) {
      this.finishTrackedTurn(params.sessionId, this.now());
      this.recordPromptFailure(params.sessionId, turnId, error);
      throw error;
    }
    const finishedAt = this.now();
    this.finishTrackedTurn(params.sessionId, finishedAt);
    this.appendHistoryUpdate(params.sessionId, finishedAt, {
      kind: "turn_finished",
      turnId,
    });
    const record = asRecord(result);
    return {
      sessionId: params.sessionId,
      turnId:
        typeof record?.turnId === "string"
          ? record.turnId
          : turnId,
    };
  }

  async loadSession(metadata: AcpSessionMetadata): Promise<AppServerThreadReplay> {
    return await this.withOperation(
      async () => await this.loadSessionOperation(metadata),
    );
  }

  private async loadSessionOperation(
    metadata: AcpSessionMetadata,
  ): Promise<AppServerThreadReplay> {
    const storedMetadata =
      this.options.store.getSession(this.options.backendId, metadata.sessionId) ??
      metadata;
    this.rememberSessionIds(storedMetadata);
    // Showing an idle-closed session needs no reload; the next request
    // reloads it.
    if (
      this.supportsSessionLoad()
      && (
        this.isSessionLoaded(storedMetadata)
        || this.idleClosedSessions.has(metadata.sessionId)
      )
    ) {
      const replay = this.normalizers.get(metadata.sessionId)?.replay();
      if (replay && (replay.entries.length > 0 || replay.messages.length > 0)) {
        return this.replayForSessionMetadata(storedMetadata);
      }
    }
    // The caller may have captured metadata before awaiting client startup.
    // A replay read must preserve archive and other updates made meanwhile.
    this.options.store.upsertSession(storedMetadata);
    const localHistory = this.hydrateSessionFromHistory(storedMetadata);
    const fallbackNormalizer = this.normalizers.get(metadata.sessionId);
    const hydratedMetadata =
      this.options.store.getSession(this.options.backendId, metadata.sessionId) ??
      metadata;
    if (this.supportsSessionLoad()) {
      const protocolSessionId = this.protocolSessionIdFor(metadata.sessionId);
      this.sessionLoadReplays.delete(protocolSessionId);
      const replayPrompts = localHistory.antigravityReplayPrompts;
      // Antigravity's prompt identities annotate a clean provider transcript.
      // Other incomplete fallbacks provide timestamps that agents such as
      // Kimi omit, so those fallbacks merge with the incoming replay.
      if (localHistory.isComplete || replayPrompts) {
        this.normalizers.delete(metadata.sessionId);
      }
      const providerNormalizer = replayPrompts && this.normalizerFor(metadata.sessionId);
      if (replayPrompts) providerNormalizer?.beginProviderPromptReplay(replayPrompts);
      try {
        await this.ensureSession(hydratedMetadata, {
          suppressTranscriptReplay: false,
        });
      } catch (error) {
        if (providerNormalizer && fallbackNormalizer) {
          this.normalizers.set(metadata.sessionId, fallbackNormalizer);
        }
        throw error;
      } finally {
        providerNormalizer?.endProviderPromptReplay(
          this.sessionLoadReplays.get(protocolSessionId)?.lastTimestampedTranscriptAt,
        );
      }
      const sessionLoadReplay = this.sessionLoadReplays.get(protocolSessionId);
      if (
        sessionLoadReplay?.lastTimestampedTranscriptAt !== undefined ||
        (!localHistory.isComplete && sessionLoadReplay)
      ) {
        return this.replayForSessionMetadata(
          this.options.store.getSession(
            this.options.backendId,
            metadata.sessionId,
          ) ?? metadata,
        );
      }
      if (fallbackNormalizer) {
        this.normalizers.set(metadata.sessionId, fallbackNormalizer);
      }
    }
    return this.replayForSessionMetadata(
      this.options.store.getSession(this.options.backendId, metadata.sessionId) ??
        metadata,
    );
  }

  async refreshSession(metadata: AcpSessionMetadata): Promise<void> {
    await this.withOperation(async () => await this.ensureSession(metadata));
  }

  async antigravityWorkspaceMatches(metadata: AcpSessionMetadata): Promise<boolean> {
    this.options.assertSessionOwner?.(metadata.sessionId);
    const cwd = metadata.cwd;
    const protocolSessionId = protocolSessionIdForMetadata(metadata);
    const primaryCwd = metadata.antigravityPrimaryCwd ?? this.antigravityPrimaryCwds.get(protocolSessionId)
      ?? (cwd && await this.withOperation(async () => await this.readAntigravityPrimaryCwd(protocolSessionId, cwd)));
    if (!cwd || !primaryCwd) {
      throw new Error("Couldn't verify Antigravity's primary workspace. Try sending the prompt again.");
    }
    this.antigravityPrimaryCwds.set(protocolSessionId, primaryCwd);
    if (primaryCwd === cwd) return true;
    const [actual, expected] = await Promise.all([
      realpath(primaryCwd).catch(() => path.resolve(primaryCwd)),
      realpath(cwd).catch(() => path.resolve(cwd)),
    ]);
    return actual === expected;
  }

  async rebindAntigravityWorkspace(metadata: AcpSessionMetadata): Promise<AcpSessionMetadata> {
    if (!this.options.rolloutStore || !metadata.cwd || !this.supportsSessionClose()) {
      throw new Error("Antigravity can't resume this thread in the destination workspace.");
    }
    const current = await this.loadSession(metadata);
    const { previous } = this.workspaceHistory(metadata);
    if (!previous && current.entries.length === 0 && current.messages.length === 0) {
      throw new Error("Couldn't recover Antigravity's conversation before switching workspaces.");
    }
    const saved = this.options.store.getSession(this.options.backendId, metadata.sessionId) ?? metadata;
    await this.closeSessionForTransfer(metadata.sessionId);
    return await this.startSession({
      sessionId: metadata.sessionId,
      cwd: metadata.cwd,
      title: saved.title,
      createdAt: saved.createdAt,
      executionMode: saved.executionMode,
      approvalPolicy: saved.approvalPolicy,
      hidden: saved.hidden,
      workspaceHandoff: {
        replay: current,
        previousAgentSessionId: protocolSessionIdForMetadata(metadata),
        mode: saved.acpRuntime?.currentModeId ?? saved.acpRuntime?.configValues?.mode,
        titleSource: saved.titleSource,
      },
    });
  }

  private async readAntigravityPrimaryCwd(protocolSessionId: string, cwd: string): Promise<string | undefined> {
    if (!this.antigravitySessionListSupported) return undefined;
    // Antigravity 1.5.16 returns the source session even with the destination
    // filter. Compare its reported primary cwd, ignoring additional roots.
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const result = asRecord(await this.options.transport.request("session/list", {
        cwd, ...(cursor ? { cursor } : {}),
      }));
      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      const session = sessions.map(asRecord).find((item) => item?.sessionId === protocolSessionId);
      if (typeof session?.cwd === "string" && path.isAbsolute(session.cwd)) return session.cwd;
      cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor || seenCursors.has(cursor)) return undefined;
      seenCursors.add(cursor);
    }
  }

  async ensureSession(
    metadata: AcpSessionMetadata,
    options: { suppressTranscriptReplay?: boolean } = {},
  ): Promise<void> {
    await this.withOperation(
      async () => await this.ensureSessionOperation(metadata, options),
    );
  }

  private async ensureSessionOperation(
    metadata: AcpSessionMetadata,
    options: AcpSessionLoadOptions,
  ): Promise<void> {
    this.rememberSessionIds(metadata);
    // A turn usually follows; keep an idle close from racing it.
    this.touchSession(metadata.sessionId);
    // The caller may hold metadata from before a prompt recorded what the
    // session was sent. That record is this client's, so keep the stored one.
    const { agentInstructionsDigest: _captured, ...captured } = metadata;
    const stored = this.options.store.getSession(
      this.options.backendId,
      metadata.sessionId,
    );
    const storedDigest = stored?.agentInstructionsDigest;
    metadata = {
      ...captured,
      ...(this.options.antigravityFullAccess !== undefined && stored
        ? { executionMode: acpSessionExecutionMode(stored), antigravityFullAccessConfirmed: stored.antigravityFullAccessConfirmed }
        : {}),
      ...(stored?.antigravityWorkspaceContextDelivered && protocolSessionIdForMetadata(stored) === protocolSessionIdForMetadata(metadata)
        ? { antigravityWorkspaceContextDelivered: true }
        : {}),
      ...(storedDigest ? { agentInstructionsDigest: storedDigest } : {}),
    };
    if (this.idleClosedSessions.has(metadata.sessionId)) {
      this.options.store.upsertSession(metadata);
      await this.reopenIdleClosedSession(metadata.sessionId, {
        ...options,
        metadata,
      });
      return;
    }
    if (this.supportsSessionLoad() && this.isSessionLoaded(metadata)) {
      return;
    }
    this.options.store.upsertSession(metadata);
    if (!this.supportsSessionLoad()) {
      return;
    }
    await this.loadSessionFromAgent(metadata, options);
  }

  /** Acknowledge dispatch after preflight. Completion still arrives through turn events. */
  startPrompt(params: {
    sessionId: string;
    prompt: string;
    promptContent?: AcpPromptContentBlock[];
    parts?: AppServerThreadMessagePart[];
    turnId?: string;
    /**
     * The thread's current Agent instructions, or an empty string for none.
     * Sent ahead of the prompt when this agent session has not been sent this
     * text. Undefined leaves the prompt alone.
     */
    agentInstructions?: string;
    readAgentMemory?: () => Promise<string | undefined>;
  }): Promise<{ sessionId: string; turnId: string }> {
    this.assertPromptAccess(params.sessionId);
    const session = this.options.store.getSession(this.options.backendId, params.sessionId);
    const needsWorkspaceContext = session?.antigravityWorkspaceRebound && !session.antigravityWorkspaceContextDelivered;
    const prompt = params.promptContent ? [...params.promptContent] : textPrompt(params.prompt);
    if (needsWorkspaceContext) {
      const priorWorkspace = this.workspaceHistory(session).previous;
      if (!priorWorkspace) throw new Error("Couldn't recover this thread's previous workspace history.");
      prompt.push({
        type: "resource",
        resource: { uri: ACP_WORKSPACE_HISTORY_URI, mimeType: "text/plain", text: acpWorkspaceContinuationText(priorWorkspace) },
      });
    }
    const turnId = params.turnId ?? `pending:${params.sessionId}:${this.now()}`;
    const activeTurn = this.startTrackedTurn(params.sessionId, turnId);
    activeTurn.sentWorkspaceContext = needsWorkspaceContext;
    const acceptance = Promise.withResolvers<{ sessionId: string; turnId: string }>();
    let dispatched = false;
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    const promptRequest = this.requestPromptWithTerminalGuard({
      protocolSessionId,
      prompt,
      sessionId: params.sessionId,
      turnId,
      agentInstructions: params.agentInstructions?.trim(),
      readAgentMemory: params.readAgentMemory,
      onDispatch: () => {
        const receivedAt = this.now();
        this.normalizerFor(params.sessionId).recordUserPrompt({
          sessionId: params.sessionId,
          prompt: params.prompt,
          parts: params.parts,
          turnId,
          receivedAt,
          waitingForAgent: true,
        });
        this.appendHistoryUpdate(params.sessionId, receivedAt, {
          kind: "pwragent_user_prompt",
          prompt: params.prompt,
          ...(params.parts?.length ? { parts: params.parts } : {}),
          turnId,
          waitingForAgent: true,
        });
        if (!needsWorkspaceContext) this.markSessionHasConversationHistory(params.sessionId, receivedAt);
        dispatched = true;
        activeTurn.promptDispatched = true;
        acceptance.resolve({ sessionId: params.sessionId, turnId });
      },
    });
    this.observeActiveTurnPrompt({
      sessionId: params.sessionId,
      activeTurn,
      generation: activeTurn.promptGeneration,
      promptPromise: promptRequest,
      isDispatched: () => dispatched,
      rejectPreDispatch: (error) => {
        acceptance.reject(error);
      },
    });
    return acceptance.promise;
  }

  private observeActiveTurnPrompt(params: {
    sessionId: string;
    activeTurn: AcpActiveTurn;
    generation: number;
    promptPromise: Promise<unknown>;
    isDispatched?: () => boolean;
    rejectPreDispatch?: (error: unknown) => void;
  }): void {
    const { sessionId, activeTurn, generation, promptPromise } = params;
    let failedPromptUsage: AcpUsageEnvelope | undefined;
    void promptPromise
      .then((result) => {
        if (params.isDispatched && !params.isDispatched()) {
          throw new Error("The ACP prompt was cancelled before it was sent.");
        }
        if (
          this.activeTurns.get(sessionId) !== activeTurn
          || activeTurn.promptGeneration !== generation
        ) {
          return;
        }
        const cancelled = promptWasCancelled(result);
        if (activeTurn.pendingSteerHandoff) {
          const handoff = activeTurn.pendingSteerHandoff;
          activeTurn.pendingSteerHandoff = undefined;
          if (!activeTurn.terminalResponseGraceStarted && isAntigravityPromptDetach(result)) {
            activeTurn.promptGeneration = handoff.nextGeneration;
            handoff.accept();
            return;
          }
          handoff.reject(
            new Error(cancelled
              ? "The active Antigravity turn was cancelled before steering was accepted"
              : "The active Antigravity turn finished before steering was accepted"),
          );
        }
        const responseError = this.missingPromptResponseError(sessionId, result);
        if (responseError) {
          failedPromptUsage = readAcpPromptResultUsageEnvelope(result, this.options.backendId);
          throw responseError;
        }
        const receivedAt = this.now();
        // A prompt that session/cancel stopped settles normally, with
        // stopReason cancelled. Carry that through, so the transcript and
        // the terminal event say the turn was interrupted, not completed.
        const promptUsage = readAcpPromptResultUsage(
          result,
          this.options.backendId,
        );
        const finished = this.finishTrackedTurn(
          sessionId,
          receivedAt,
          cancelled ? "interrupted" : "completed",
          !cancelled && activeTurn.sentWorkspaceContext,
        );
        this.appendHistoryUpdate(sessionId, receivedAt, {
          kind: "turn_finished",
          ...(finished.turnId ? { turnId: finished.turnId } : {}),
          outputText: finished.assistantText,
          ...(cancelled ? { stopReason: "cancelled" } : {}),
          ...(promptUsage ? { usage: promptUsage } : {}),
        });
        void this.notifySessionUpdate({
          sessionId,
          replay: finished.replay,
          turnId: finished.turnId,
          update: {
            kind: "turn_finished",
            outputText: finished.assistantText,
            ...(cancelled ? { stopReason: "cancelled" } : {}),
            ...(promptUsage ? { usage: promptUsage } : {}),
          },
        });
      })
      .catch(async (error) => {
        if (params.isDispatched && !params.isDispatched()) {
          this.activeTurns.delete(sessionId);
          this.touchSession(sessionId);
          this.updateSessionStatus(sessionId, "idle");
          params.rejectPreDispatch?.(error);
          return;
        }
        if (
          this.activeTurns.get(sessionId) !== activeTurn
          || activeTurn.promptGeneration !== generation
        ) {
          return;
        }
        if (activeTurn.pendingSteerHandoff) {
          const handoff = activeTurn.pendingSteerHandoff;
          activeTurn.pendingSteerHandoff = undefined;
          handoff.reject(error);
        }
        if (promptMayStillBeRunning(error)) {
          // The agent never answered this prompt, so it may still be working
          // and asking for approvals. Cancel it while the turn is still
          // tracked: no new prompt can start until then, so the cancel
          // cannot reach the next turn.
          await this.cancelSessionOperation(sessionId).catch(
            () => undefined,
          );
        }
        this.finishTrackedTurn(sessionId, this.now());
        this.recordPromptFailure(sessionId, activeTurn.turnId, error);
        return Promise.resolve(
          this.options.onPromptError?.({
            sessionId,
            turnId: activeTurn.turnId,
            error,
            ...(failedPromptUsage ? { usage: failedPromptUsage } : {}),
          }),
        ).catch(() => undefined);
      });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.withOperation(
      async () => await this.cancelSessionOperation(sessionId),
    );
  }

  private async cancelSessionOperation(sessionId: string): Promise<void> {
    const cancelBeforePrompt = this.activeTurns.get(sessionId)?.cancelBeforePrompt;
    if (cancelBeforePrompt) {
      cancelBeforePrompt();
      return;
    }
    if (!this.options.transport.notify) {
      throw new Error("ACP transport does not support notifications");
    }
    await this.options.transport.notify("session/cancel", {
      sessionId: this.protocolSessionIdFor(sessionId),
    });
  }

  async sendControlPrompt(params: {
    sessionId: string;
    prompt: string;
  }): Promise<{
    text: string;
    model?: string;
    tokenUsage?: AcpSuppressedControlPrompt["tokenUsage"];
  }> {
    return await this.withOperation(
      async () => await this.sendControlPromptOperation(params),
    );
  }

  private async sendControlPromptOperation(params: {
    sessionId: string;
    prompt: string;
  }): Promise<{
    text: string;
    model?: string;
    tokenUsage?: AcpSuppressedControlPrompt["tokenUsage"];
  }> {
    const reload = this.reloadBeforeRequest(params.sessionId);
    if (reload) await reload;
    this.assertPromptAccess(params.sessionId);
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    const selectedModel = readAcpSelectedModel(
      this.options.store.getSession(this.options.backendId, params.sessionId)
        ?.acpRuntime,
    );
    const suppression: AcpSuppressedControlPrompt = {
      finalTextChunks: [],
      ...(selectedModel ? { model: selectedModel } : {}),
    };
    this.suppressedControlPromptSessions.set(protocolSessionId, suppression);
    try {
      const result = await this.options.transport.request(
        "session/prompt",
        {
          sessionId: protocolSessionId,
          prompt: textPrompt(params.prompt),
        },
        ACP_CONTROL_PROMPT_REQUEST_TIMEOUT_MS,
      );
      const promptUsage = readAcpPromptResultUsageEnvelope(
        result,
        this.options.backendId,
      );
      if (promptUsage) {
        suppression.tokenUsage = foldAcpTurnUsage(
          suppression.tokenUsage,
          promptUsage,
        );
        suppression.model = promptUsage.model ?? suppression.model;
      }
      return {
        text:
          suppression.finalTextChunks.join("").trim() ||
          suppression.fallbackOutputText?.trim() ||
          "",
        ...(suppression.model ? { model: suppression.model } : {}),
        ...(suppression.tokenUsage
          ? { tokenUsage: suppression.tokenUsage }
          : {}),
      };
    } finally {
      this.suppressedControlPromptSessions.delete(protocolSessionId);
    }
  }

  async setRuntimeOption(params: AcpRuntimeOptionWrite): Promise<BackendAcpSessionRuntimeState | undefined> {
    return await this.withOperation(
      async () => await this.setRuntimeOptionOperation(params),
    );
  }

  private async setRuntimeOptionOperation(params: AcpRuntimeOptionWrite): Promise<BackendAcpSessionRuntimeState | undefined> {
    if (params.antigravityModeSession) {
      await this.ensureSessionOperation(params.antigravityModeSession, { antigravityModeSelection: params.value });
      const current = this.options.store.getSession(this.options.backendId, params.sessionId)?.acpRuntime;
      if (current?.configValues?.[params.optionId] === params.value) return current;
    }
    const reload = this.reloadBeforeRequest(params.sessionId);
    if (reload) await reload;
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    const value = params.sessionStartMode
      ? this.sessionStartModeValue(protocolSessionId, params)
      : params.value;
    if (value === undefined) {
      return this.recordUnwrittenSessionStartMode(protocolSessionId, params);
    }
    const write = await this.setRuntimeOptionOnTransport({
      protocolSessionId,
      source: params.source,
      optionId: params.optionId,
      value,
      reasoningEffort: params.reasoningEffort,
    });
    if (write.unofferedThoughtLevel) {
      const refused =
        params.source === "configOption"
        && params.rejectUnofferedThoughtLevel === true;
      // Debug, not info: a composer effort the model does not offer is
      // retried by every turn start, so this can repeat once per turn.
      acpClientLog.debug(
        refused
          ? "refused a thought level the session's model does not offer"
          : "skipped a thought level the session's model does not offer",
        {
          backendId: this.options.backendId,
          source: params.source,
          value:
            params.source === "configOption"
              ? value
              : params.reasoningEffort,
        },
      );
      if (refused) {
        // The refusal the agent would have sent, without the round trip.
        throw new Error(
          `The session's model does not offer "${value}" for ${params.optionId}`,
        );
      }
      if (params.source === "configOption") {
        return this.options.store.getSession(
          this.options.backendId,
          params.sessionId,
        )?.acpRuntime;
      }
    }
    const result = write.result;
    if (params.antigravityModeSession) this.assertAntigravityModeConfirmed(result, value, "apply");
    const reasoningEffort = write.unofferedThoughtLevel
      ? undefined
      : params.reasoningEffort;
    const now = this.now();
    const runtimeCapabilities = this.captureRuntimeCapabilities({
      source: "session-load",
      result,
    });
    const responseRuntimeState = this.runtimeStateFromResponse(result, now);
    const modelConfigOption = this.runtimeConfigOption("model");
    const thoughtLevelConfigOption = this.runtimeConfigOption("thought_level");
    const requestedRuntimeState: BackendAcpSessionRuntimeState =
      params.source === "configOption"
        ? {
            configValues: { [params.optionId]: value },
            ...(this.isRuntimeModeConfigOption(params.optionId)
              ? { currentModeId: value }
              : {}),
            updatedAt: now,
          }
        : params.source === "mode"
          ? {
              currentModeId: value,
              updatedAt: now,
            }
          : {
              currentModelId: value,
              ...(modelConfigOption
                ? {
                    configValues: {
                      [modelConfigOption.id]: value,
                      ...(reasoningEffort && thoughtLevelConfigOption
                        ? {
                            [thoughtLevelConfigOption.id]: reasoningEffort,
                          }
                        : {}),
                    },
                  }
                : {}),
              reasoningEffort:
                responseRuntimeState?.reasoningEffort ??
                reasoningEffort,
              updatedAt: now,
            };
    const runtimeState = mergeAcpRuntimeState(
      responseRuntimeState ?? { updatedAt: now },
      requestedRuntimeState,
    );
    this.updateSessionRuntimeState(params.sessionId, runtimeState);
    this.notifyRuntimeCapabilities({
      sessionId: params.sessionId,
      runtimeCapabilities,
      runtimeState,
    });
    return runtimeState;
  }

  private rememberSessionModeMenu(protocolSessionId: string, result: unknown): void {
    const runtime = normalizeAcpRuntimeCapabilities({
      value: result,
      now: this.now(),
      source: "session-load",
    });
    this.sessionModeMenus.set(protocolSessionId, {
      ...(runtime?.modes ? { modes: runtime.modes } : {}),
      configOptions:
        runtime?.configOptions?.filter((option) => option.category === "mode") ?? [],
    });
  }

  /**
   * The mode a session start writes for `params.value`, by the menu that
   * session's own start reply listed; undefined writes none. Antigravity
   * 1.5.15 refuses a mode the session does not list with -32602
   * `Unknown mode: <id>`, through session/set_mode and its `mode` option alike.
   */
  private sessionStartModeValue(
    protocolSessionId: string,
    params: AcpRuntimeOptionWrite,
  ): string | undefined {
    const menu = this.sessionModeMenus.get(protocolSessionId);
    // No start reply was seen for this session, so the agent decides.
    if (!menu) return params.value;
    const offered = params.source === "mode"
      ? menu.modes?.availableModes.map((mode) => mode.id) ?? []
      : menu.configOptions
        .find((option) => option.id === params.optionId)
        ?.values.map((value) => value.value) ?? [];
    const value = acpSessionStartMode(params.value, offered);
    if (value !== params.value) {
      acpClientLog.info("the session does not offer the requested start mode", {
        backendId: this.options.backendId,
        optionId: params.optionId,
        requested: params.value,
        applied: value ?? null,
      });
    }
    return value;
  }

  /**
   * Records the mode a session kept when its start wrote none. session/new
   * stored the requested mode beside the reply's, and a reply without a mode
   * menu left the requested one standing.
   */
  private recordUnwrittenSessionStartMode(
    protocolSessionId: string,
    params: AcpRuntimeOptionWrite,
  ): BackendAcpSessionRuntimeState | undefined {
    const metadata = this.options.store.getSession(this.options.backendId, params.sessionId);
    if (!metadata) return undefined;
    const menu = this.sessionModeMenus.get(protocolSessionId);
    const kept = params.source === "mode"
      ? menu?.modes?.currentModeId
      : menu?.configOptions.find((option) => option.id === params.optionId)?.currentValue;
    const { currentModeId, ...withoutMode } = metadata.acpRuntime ?? {};
    // Every mode selector but Grok's permission config mirrors currentModeId.
    const modeId = params.source === "mode" || params.optionId !== ACP_PERMISSION_MODE_OPTION_ID
      ? kept
      : currentModeId;
    const configValues = Object.fromEntries(
      Object.entries(withoutMode.configValues ?? {}).filter(([id]) =>
        params.source !== "configOption" || id !== params.optionId),
    );
    if (params.source === "configOption" && kept !== undefined) {
      configValues[params.optionId] = kept;
    }
    const runtime: BackendAcpSessionRuntimeState = {
      ...withoutMode,
      configValues,
      ...(modeId !== undefined ? { currentModeId: modeId } : {}),
      updatedAt: this.now(),
    };
    this.options.store.upsertSession({ ...metadata, acpRuntime: runtime });
    return runtime;
  }

  private isRuntimeModeConfigOption(optionId: string): boolean {
    return findAcpMirroredModeConfigOption(this.runtimeCapabilities)?.id === optionId;
  }

  private runtimeConfigOption(
    category: string,
  ): BackendAcpRuntimeConfigOption | undefined {
    return this.runtimeCapabilities?.configOptions?.find(
      (option) => option.category === category,
    );
  }

  private runtimeStateFromResponse(result: unknown, now: number) {
    return acpSessionRuntimeStateFromResponse(result, now, this.options.backendId === "acp:antigravity");
  }

  private async setRuntimeOptionOnTransport(params: {
    protocolSessionId: string;
    source: BackendAcpRuntimeOptionSource;
    optionId: string;
    value: string;
    reasoningEffort?: string;
  }): Promise<{
    result: unknown;
    /** A thought level went unwritten: the session's model does not offer it. */
    unofferedThoughtLevel?: true;
  }> {
    if (params.source === "configOption") {
      if (
        !this.sessionOffersConfigValue(
          params.protocolSessionId,
          params.optionId,
          params.value,
        )
      ) {
        return { result: undefined, unofferedThoughtLevel: true };
      }
      return {
        result: await this.requestSessionOption(
          params.protocolSessionId,
          "session/set_config_option",
          {
            sessionId: params.protocolSessionId,
            configId: params.optionId,
            value: params.value,
          },
        ),
      };
    }

    if (params.source === "mode") {
      return {
        result: await this.requestSessionOption(
          params.protocolSessionId,
          "session/set_mode",
          {
            sessionId: params.protocolSessionId,
            modeId: params.value,
          },
        ),
      };
    }

    const modelConfigOption = this.runtimeConfigOption("model");
    if (modelConfigOption) {
      const result = await this.requestSessionOption(
        params.protocolSessionId,
        "session/set_config_option",
        {
          sessionId: params.protocolSessionId,
          configId: modelConfigOption.id,
          value: params.value,
        },
      );
      const thoughtLevelConfigOption =
        this.runtimeConfigOption("thought_level");
      if (!params.reasoningEffort || !thoughtLevelConfigOption) {
        return { result };
      }
      // The model write can change which thought levels exist, and its reply
      // is the new model's menu. The level may have been chosen for another
      // model, as when a review child re-selects its parent's model.
      if (
        !this.sessionOffersConfigValue(
          params.protocolSessionId,
          thoughtLevelConfigOption.id,
          params.reasoningEffort,
        )
      ) {
        return { result, unofferedThoughtLevel: true };
      }
      return {
        result: await this.requestSessionOption(
          params.protocolSessionId,
          "session/set_config_option",
          {
            sessionId: params.protocolSessionId,
            configId: thoughtLevelConfigOption.id,
            value: params.reasoningEffort,
          },
        ),
      };
    }

    return {
      result: await this.requestSessionOption(
        params.protocolSessionId,
        "session/set_model",
        {
          sessionId: params.protocolSessionId,
          modelId: params.value,
          ...(params.reasoningEffort
            ? { _meta: { reasoningEffort: params.reasoningEffort } }
            : {}),
        },
      ),
    };
  }

  private async requestSessionOption(
    protocolSessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await this.options.transport.request(method, params);
    this.rememberSessionConfigOptions(protocolSessionId, result);
    return result;
  }

  // A reply without the menu leaves it unknown rather than stale, and an
  // unknown menu leaves the decision to the agent.
  private rememberSessionConfigOptions(
    protocolSessionId: string,
    result: unknown,
  ): void {
    const configOptions = normalizeAcpRuntimeCapabilities({
      value: result,
      now: this.now(),
      source: "session-load",
    })?.configOptions;
    if (configOptions) {
      this.sessionConfigOptions.set(protocolSessionId, configOptions);
    } else {
      this.sessionConfigOptions.delete(protocolSessionId);
    }
  }

  /** False only when a model write would drop `level` for this session: its
   *  own latest reply reported a thought-level menu without it. */
  offersThoughtLevel(sessionId: string, level: string): boolean {
    const thoughtLevelConfigOption = this.runtimeConfigOption("thought_level");
    return (
      !thoughtLevelConfigOption
      || this.sessionOffersConfigValue(
        this.protocolSessionIdFor(sessionId),
        thoughtLevelConfigOption.id,
        level,
      )
    );
  }

  /** False only for a thought level this session's current model does not
   *  offer, by the menu its own latest reply reported. */
  private sessionOffersConfigValue(
    protocolSessionId: string,
    optionId: string,
    value: string,
  ): boolean {
    const option = this.sessionConfigOptions
      .get(protocolSessionId)
      ?.find((candidate) => candidate.id === optionId);
    return (
      option?.category !== "thought_level"
      || option.values.some((candidate) => candidate.value === value)
    );
  }

  readReplay(sessionId: string): AppServerThreadReplay {
    return this.normalizerFor(sessionId).replay();
  }

  didSessionLoadReplayHistory(sessionId: string): boolean {
    return this.sessionLoadReplays.has(this.protocolSessionIdFor(sessionId));
  }

  private applySessionUpdate(params: Record<string, unknown>): void {
    const protocolSessionId =
      typeof params.sessionId === "string" ? params.sessionId : undefined;
    const update = withAcpSessionUpdateEnvelopeMetadata(
      asRecord(params.update),
      asRecord(params._meta),
    );
    if (!protocolSessionId || !update) {
      return;
    }
    const optionUpdateKind = readUpdateKind(update);
    if (
      optionUpdateKind === "config_option_update"
      || optionUpdateKind === "model_changed"
    ) {
      // The agent changed this session's options, possibly on its own. The
      // next reply reports the menu again; until then it is unknown.
      this.sessionConfigOptions.delete(protocolSessionId);
    }
    const suppressedControlPrompt =
      this.suppressedControlPromptSessions.get(protocolSessionId);
    if (suppressedControlPrompt) {
      const updateKind = readUpdateKind(update);
      if (updateKind === "agent_message_chunk") {
        const text = readUpdateText(update);
        if (text) {
          suppressedControlPrompt.finalTextChunks.push(text);
        }
      } else if (
        updateKind === "turn_finished" &&
        suppressedControlPrompt.finalTextChunks.length === 0
      ) {
        const text = readUpdateText(update);
        if (text) {
          suppressedControlPrompt.fallbackOutputText = text;
        }
      }
      const usage = readAcpUsageEnvelope(update, this.options.backendId);
      if (usage) {
        suppressedControlPrompt.tokenUsage = foldAcpTurnUsage(
          suppressedControlPrompt.tokenUsage,
          usage,
        );
        suppressedControlPrompt.model =
          usage.model ?? suppressedControlPrompt.model;
      }
      return;
    }
    const sessionId = this.appSessionIdFor(protocolSessionId);
    const receivedAt = this.now();
    if (this.sessionLastActivityAt.has(sessionId)) this.touchSession(sessionId);
    const activityAt = readAcpUpdateTimestamp(update) ?? receivedAt;
    const loadState = this.loadingSessions.get(protocolSessionId);
    const isExplicitSessionReplay = isAcpSessionReplayUpdate(update);
    const fromSessionLoad = loadState !== undefined || isExplicitSessionReplay;
    const activeTurn = this.activeTurns.get(sessionId);
    const updateKind = readUpdateKind(update);
    if (loadState?.restoringAntigravityMode
      && (updateKind === "current_mode_update" || updateKind === "config_option_update")) {
      // Publish the restored mode only after the restore reply confirms it.
      return;
    }
    if (!fromSessionLoad) this.observeNativeBackgroundWork(sessionId, updateKind, update);
    // Only a live update ends the turn. A prompt for an idle-closed session
    // reloads it while the turn is tracked, and session/load replays the
    // earlier turns' terminal updates.
    if (
      activeTurn
      && !fromSessionLoad
      && (updateKind === "turn_finished" || updateKind === "turn_completed")
    ) {
      activeTurn.onTerminalUpdate?.();
    }
    // A compaction may summarize the instruction block away, so the next
    // prompt carries it again. Grok reports one; Kimi, Qwen and Gemini show
    // it only as a fall in context fill. A compaction replayed by
    // session/load happened before the block was last recorded.
    if (
      !fromSessionLoad
      && (
        updateKind === "auto_compact_completed"
        || this.contextFillHalved(sessionId, protocolSessionId, update, updateKind)
      )
    ) {
      if (activeTurn) activeTurn.compacted = true;
      this.recordDeliveredAgentInstructions(sessionId, undefined);
    }
    if (isProviderTranscriptReplayUpdate(update)) {
      if (loadState) {
        loadState.replayedTranscript = true;
        if (readAcpUpdateTimestamp(update) !== undefined) {
          loadState.lastTimestampedTranscriptAt = Math.max(
            loadState.lastTimestampedTranscriptAt ?? 0,
            activityAt,
          );
        }
      } else if (isExplicitSessionReplay) {
        const existing = this.sessionLoadReplays.get(protocolSessionId);
        this.sessionLoadReplays.set(protocolSessionId, {
          ...(existing ?? {}),
          ...(readAcpUpdateTimestamp(update) !== undefined
            ? {
                lastTimestampedTranscriptAt: Math.max(
                  existing?.lastTimestampedTranscriptAt ?? 0,
                  activityAt,
                ),
              }
            : {}),
        });
      }
    }
    const runtimeState = acpSessionRuntimeStateFromUpdate(update, activityAt);
    if (runtimeState) {
      this.updateSessionRuntimeState(sessionId, runtimeState, {
        touchActivity: !fromSessionLoad,
      });
      void Promise.resolve(
        this.options.onSessionRuntimeStateChange?.({
          ...(fromSessionLoad ? { fromSessionLoad: true } : {}),
          sessionId,
          runtimeState,
        }),
      ).catch(() => undefined);
      return;
    }
    if (loadState?.suppressTranscriptReplay && isTranscriptReplayUpdate(update)) {
      return;
    }
    if (updateKind === "available_commands_update") {
      this.updateSessionAvailableCommands(sessionId, update, activityAt, {
        // Providers refresh command capabilities during and immediately after
        // session/load. Capability metadata is not conversation activity,
        // even when a late notification no longer carries replay provenance.
        touchActivity: false,
      });
    }
    if (updateKind === "turn_started") {
      this.updateSessionStatus(sessionId, "active", activityAt, {
        touchActivity: !fromSessionLoad,
      });
    } else if (
      (updateKind === "turn_finished" && activeTurn === undefined) ||
      updateKind === "pwragent_turn_failed" ||
      (updateKind === "turn_completed" && activeTurn === undefined)
    ) {
      this.updateSessionStatus(sessionId, "idle", activityAt, {
        touchActivity: !fromSessionLoad,
      });
    }
    const title = this.updateSessionTitleFromAcpUpdate(
      sessionId,
      update,
      activityAt,
      { touchActivity: !fromSessionLoad },
    );
    if (isConversationHistoryUpdate(update)
      && !(updateKind === "user_message_chunk" && isAcpUserBoilerplateMessage(readUpdateText(update)))) {
      this.markSessionHasConversationHistory(sessionId, activityAt, {
        touchActivity: !fromSessionLoad,
      });
    }
    // PwrAgent already saved the original prompt before sending it. The
    // provider echo can contain the index and belongs only in the live filter.
    if (!fromSessionLoad && !(activeTurn?.sentAgentMemory && updateKind === "user_message_chunk")) {
      this.appendHistoryUpdate(sessionId, receivedAt, update);
    }
    const normalizer = this.normalizerFor(sessionId);
    const replay = normalizer.apply({
      sessionId,
      update,
      receivedAt,
      deferTurnCompletion:
        (updateKind === "turn_finished" || updateKind === "turn_completed")
        && activeTurn !== undefined,
    } satisfies AcpSessionUpdate);
    const shouldTrackAssistantTextUpdate =
      updateKind === "agent_message_chunk" ||
      (updateKind === "agent_thought_chunk"
        && this.normalizerOptions.surfaceThoughtsAsMessages === true);
    const text = readUpdateText(update);
    // Replay owns message boundaries, including metadata, late tool progress,
    // explicit IDs, and phase changes. A second live-only tracker can split a
    // paragraph that the normalizer correctly keeps together after reload.
    const assistantMessageItemId =
      activeTurn && shouldTrackAssistantTextUpdate && text
        ? normalizer.readActiveAssistantMessageId()
        : undefined;
    if (activeTurn && assistantMessageItemId && updateKind === "agent_message_chunk") {
      activeTurn.assistantText += text;
    } else if (
      activeTurn
      && text
      && !activeTurn.assistantText.trim()
      && (updateKind === "turn_finished" || updateKind === "turn_completed")
    ) {
      // Some ACP agents send the final answer only on the terminal update
      // instead of streaming agent_message_chunk events. Preserve that valid
      // response before the session/prompt result is checked for silence.
      activeTurn.assistantText = text;
    }
    void this.notifySessionUpdate({
      assistantMessageItemId,
      ...(fromSessionLoad ? { fromSessionLoad: true } : {}),
      sessionId,
      replay,
      title,
      turnId: activeTurn?.turnId,
      update,
    });
  }

  private async handleAcpRequest(
    method: string,
    params: Record<string, unknown>,
    id?: JsonRpcId,
  ): Promise<unknown> {
    if (method !== "session/request_permission") {
      throw new Error(`Unsupported ACP request: ${method}`);
    }

    const protocolSessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const session = protocolSessionId
      ? this.options.store.getSession(this.options.backendId, this.appSessionIdFor(protocolSessionId))
      : undefined;
    if (session?.approvalPolicy === "deny-all") {
      return cancelledPermissionOutcome();
    }

    const permissionOptions = readPermissionOptions(params.options);
    const allowedWithoutOperator = protocolSessionId
      ? await this.permissionAnsweredWithoutOperator(
        this.appSessionIdFor(protocolSessionId),
        params,
        permissionOptions,
      )
      : undefined;
    if (allowedWithoutOperator) {
      return { outcome: { outcome: "selected", optionId: allowedWithoutOperator } };
    }

    const request = this.normalizePermissionRequest(params, id);
    if (!request || !this.options.onRequest) {
      return cancelledPermissionOutcome();
    }

    // A session waiting on the operator must stay open to hear the answer.
    const sessionId = request.params.threadId;
    this.pendingPermissionRequests.set(
      sessionId,
      (this.pendingPermissionRequests.get(sessionId) ?? 0) + 1,
    );
    this.touchSession(sessionId);
    try {
      const response = await this.options.onRequest(request);
      const toolName = request.params.acpMcpToolName;
      const allowOnce = allowOncePermissionOptionId(permissionOptions);
      if (toolName && allowOnce && isThreadToolGrantResponse(response, request)) {
        const grants = this.sessionMcpToolGrants.get(sessionId) ?? new Set<string>();
        grants.add(toolName);
        this.sessionMcpToolGrants.set(sessionId, grants);
        return { outcome: { outcome: "selected", optionId: allowOnce } };
      }
      return permissionOutcomeFromResponse(response, permissionOptions);
    } finally {
      const remaining = (this.pendingPermissionRequests.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.pendingPermissionRequests.set(sessionId, remaining);
      else this.pendingPermissionRequests.delete(sessionId);
      this.touchSession(sessionId);
    }
  }

  private normalizePermissionRequest(
    params: Record<string, unknown>,
    id?: JsonRpcId,
  ): AppServerPendingRequestNotification | undefined {
    const protocolSessionId =
      typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (!protocolSessionId) {
      return undefined;
    }
    const sessionId = this.appSessionIdFor(protocolSessionId);
    const toolCall = asRecord(params.toolCall) ?? {};
    const title =
      typeof toolCall.title === "string" && toolCall.title.trim()
        ? toolCall.title.trim()
        : "ACP tool call";
    const toolCallId =
      typeof toolCall.toolCallId === "string"
        ? toolCall.toolCallId
        : typeof toolCall.tool_call_id === "string"
          ? toolCall.tool_call_id
          : undefined;
    const requestId = id == null ? toolCallId ?? `acp:${this.now()}` : String(id);
    const activeTurn = this.activeTurns.get(sessionId);
    const acpMcpToolName = this.antigravityMcpToolName(toolCall);
    const permissionOptions = readPermissionOptions(params.options);
    const prompt = acpMcpToolName
      ? mcpPermissionPrompt(this.approvalRequesterName, acpMcpToolName, toolCall)
      : permissionPrompt(this.approvalRequesterName, title, toolCall);
    const command = acpMcpToolName ? undefined : permissionCommand(title, toolCall);

    return {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: sessionId,
        ...(activeTurn?.turnId ? { turnId: activeTurn.turnId } : {}),
        requestId,
        prompt,
        reason: prompt,
        ...(acpMcpToolName ? { acpMcpToolName } : { command, displayCommand: command }),
        acpMethod: "session/request_permission",
        acpToolCallId: toolCallId,
        acpToolKind: typeof toolCall.kind === "string" ? toolCall.kind : undefined,
        acpPermissionOptions: acpMcpToolName
          ? withThreadToolGrantOption(permissionOptions)
          : permissionOptions,
      },
    };
  }

  /**
   * Antigravity reports MCP invocations as kind "other" with a flattened
   * tool name. The name is as reported, so use it to display or to match a
   * grant the operator made for that exact name, never to infer a server.
   */
  private antigravityMcpToolName(toolCall: Record<string, unknown>): string | undefined {
    return this.options.backendId === "acp:antigravity"
      && toolCall.kind === "other"
      && typeof toolCall.name === "string"
      && /^mcp_[A-Za-z0-9_-]+$/u.test(toolCall.name)
      ? toolCall.name
      : undefined;
  }

  /**
   * The agent's `allow_once` option when the operator need not be asked: the
   * operator already allowed this MCP tool for the thread, or the call is to
   * one of PwrAgent's own tools that PwrAgent approves itself or that only
   * reads. A name that more than one session server could have produced
   * still asks.
   */
  private async permissionAnsweredWithoutOperator(
    sessionId: string,
    params: Record<string, unknown>,
    options: AcpPermissionOption[],
  ): Promise<string | undefined> {
    const toolName = this.antigravityMcpToolName(asRecord(params.toolCall) ?? {});
    const allowOnce = allowOncePermissionOptionId(options);
    if (!toolName || !allowOnce) return undefined;
    const servers = this.sessionMcpServers.get(sessionId);
    if (!servers?.registeredNames) return undefined;
    if (this.sessionMcpToolGrants.get(sessionId)?.has(toolName)) return allowOnce;
    if (!servers.hostApprovesToolCall) return undefined;
    const target = resolveAntigravityMcpToolTarget(toolName, servers.agentNames);
    if (!target || !servers.registeredNames.has(target.serverName)) return undefined;
    try {
      return await servers.hostApprovesToolCall(target.serverName, target.toolName)
        ? allowOnce
        : undefined;
    } catch (error) {
      acpClientLog.warn("could not check ACP MCP tool approval; asking the operator", {
        sessionId,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private normalizerOptionsFor(metadata?: AcpSessionMetadata): AcpSessionReplayNormalizerOptions {
    return {
      ...this.normalizerOptions,
      cwd: metadata?.cwd,
      workspaceSessionId: metadata?.antigravityWorkspaceRebound ? protocolSessionIdForMetadata(metadata) : undefined,
    };
  }

  private normalizerFor(sessionId: string): AcpSessionReplayNormalizer {
    let normalizer = this.normalizers.get(sessionId);
    if (!normalizer) {
      normalizer = new AcpSessionReplayNormalizer(
        this.normalizerOptionsFor(
          this.options.store.getSession(this.options.backendId, sessionId),
        ),
      );
      this.normalizers.set(sessionId, normalizer);
    }
    return normalizer;
  }

  private replayForSessionMetadata(
    metadata: AcpSessionMetadata,
  ): AppServerThreadReplay {
    const normalizer = this.normalizerFor(metadata.sessionId);
    const replay = normalizer.replay();
    return {
      ...replay,
      threadStatus: acpSessionThreadStatus(metadata.status, replay.threadStatus),
    };
  }

  private hydrateSessionFromHistory(
    metadata: AcpSessionMetadata,
  ): AcpHydratedSessionHistory {
    if (!this.options.rolloutStore) {
      return { isComplete: false };
    }
    const normalizer = new AcpSessionReplayNormalizer(
      this.normalizerOptionsFor(metadata),
    );
    let hasTranscriptHistory = false;
    const antigravityReplayPrompts: AcpReplayPromptIdentity[] = [];
    const { current: records } = this.workspaceHistory(metadata);
    for (const record of records) {
      if (isPwrAgentSyntheticAcpUpdate(record.update)) {
        continue;
      }
      if (this.options.backendId === "acp:antigravity") {
        const identity = readAntigravityReplayPromptIdentity(record);
        if (identity) antigravityReplayPrompts.push(identity);
      }
      if (isTranscriptReplayUpdate(record.update)) {
        hasTranscriptHistory = true;
      }
      normalizer.apply({
        sessionId: metadata.sessionId,
        receivedAt: record.receivedAt,
        update: record.update,
      });
    }
    this.normalizers.set(metadata.sessionId, normalizer);
    const replay = normalizer.replay();
    const hasReplay = replay.messages.length > 0 || replay.entries.length > 0;
    return {
      isComplete: (hasTranscriptHistory || hasReplay) && replay.threadStatus === "idle",
      antigravityReplayPrompts: ((metadata.antigravityWorkspaceRebound && antigravityReplayPrompts.length > 0)
        || antigravityReplayPrompts.some((prompt) => prompt.steerMessageId))
        ? antigravityReplayPrompts : undefined,
    };
  }

  private workspaceHistory(metadata: AcpSessionMetadata) {
    return acpWorkspaceHistory(this.options.rolloutStore?.readUpdates({
      backendId: this.options.backendId,
      sessionId: metadata.sessionId,
    }) ?? [], metadata.antigravityWorkspaceRebound ? protocolSessionIdForMetadata(metadata) : undefined);
  }

  private markSessionHasConversationHistory(
    sessionId: string,
    receivedAt: number,
    options: AcpSessionMetadataUpdateOptions = {},
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata || metadata.hasConversationHistory) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      hasConversationHistory: true,
      updatedAt:
        options.touchActivity === false
          ? metadata.updatedAt
          : Math.max(metadata.updatedAt, receivedAt),
    });
  }

  private updateSessionAvailableCommands(
    sessionId: string,
    update: Record<string, unknown>,
    receivedAt: number,
    options: AcpSessionMetadataUpdateOptions = {},
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      availableCommands: normalizeAvailableCommandsUpdate(
        update,
        this.options.backendId,
      ),
      updatedAt:
        options.touchActivity === false
          ? metadata.updatedAt
          : Math.max(metadata.updatedAt, receivedAt),
    });
  }

  private captureRuntimeCapabilities(params: {
    source: BackendAcpRuntimeCapabilities["source"];
    result: unknown;
  }): BackendAcpRuntimeCapabilities | undefined {
    const runtimeCapabilities = normalizeAcpRuntimeCapabilities({
      value: params.result,
      now: this.now(),
      source: params.source,
      initialize: this.runtimeCapabilities,
    });
    if (runtimeCapabilities) {
      this.runtimeCapabilities = runtimeCapabilities;
    }
    return runtimeCapabilities;
  }

  private notifyRuntimeCapabilities(event: {
    fromSessionLoad?: boolean;
    sessionId?: string;
    runtimeCapabilities?: BackendAcpRuntimeCapabilities;
    runtimeState?: BackendAcpSessionRuntimeState;
  }): void {
    if (!event.runtimeCapabilities) {
      return;
    }
    void Promise.resolve(
      this.options.onRuntimeCapabilities?.({
        ...(event.fromSessionLoad ? { fromSessionLoad: true } : {}),
        sessionId: event.sessionId,
        runtimeCapabilities: event.runtimeCapabilities,
        runtimeState: event.runtimeState,
      }),
    ).catch(() => undefined);
  }

  private updateSessionRuntimeState(
    sessionId: string,
    runtimeState: BackendAcpSessionRuntimeState,
    options: AcpSessionMetadataUpdateOptions = {},
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      acpRuntime: mergeAcpRuntimeState(metadata.acpRuntime, runtimeState),
      updatedAt:
        options.touchActivity === false
          ? metadata.updatedAt
          : Math.max(metadata.updatedAt, runtimeState.updatedAt ?? this.now()),
    });
  }

  private async notifySessionUpdate(event: {
    assistantMessageItemId?: string;
    fromSessionLoad?: boolean;
    sessionId: string;
    replay: AppServerThreadReplay;
    title?: string;
    turnId?: string;
    update: Record<string, unknown>;
  }): Promise<void> {
    await Promise.resolve(this.options.onSessionUpdate?.(event)).catch(
      () => undefined,
    );
  }

  private async loadSessionFromAgent(
    metadata: AcpSessionMetadata,
    options: AcpSessionLoadOptions = {},
  ): Promise<unknown> {
    if (!this.supportsSessionLoad()) {
      return undefined;
    }
    const cwd = metadata.cwd ?? process.cwd();
    const protocolSessionId = protocolSessionIdForMetadata(metadata);
    const agentToolCatalogKey = this.options.agentToolCatalogKey?.();
    const jobMonitorCreationEnabled = this.jobMonitorCatalogRefreshSupported
      ? await this.options.readJobMonitorCreationPreference?.(metadata.sessionId) : undefined;
    const mcpRegistration = await this.buildMcpServers({
      cwd,
      sessionId: metadata.sessionId,
    });
    if (this.supportsJobMonitorControl(metadata.sessionId) && !mcpRegistration.readListedJobMonitorCreation) {
      throw new Error("Couldn't reconnect PwrAgent's Job Monitor tools. Try sending the prompt again.");
    }
    const requestedMode = options.antigravityModeSelection;
    const mode = this.options.backendId === "acp:antigravity"
      ? requestedMode ?? metadata.acpRuntime?.currentModeId ?? metadata.acpRuntime?.configValues?.mode
      : undefined;
    const loadState: AcpSessionLoadState = {
      replayedTranscript: false,
      suppressTranscriptReplay: options.suppressTranscriptReplay === true,
      restoringAntigravityMode: Boolean(mode),
    };
    this.loadingSessions.set(protocolSessionId, loadState);
    const mcpServerWireConfigs = toAcpMcpServerWireConfigs(mcpRegistration.servers);
    let result: unknown;
    try {
      result = await this.options.transport.request("session/load", {
        cwd,
        mcpServers: mcpServerWireConfigs,
        sessionId: protocolSessionId,
      });
      if (mode) {
        try {
          result = await this.confirmAntigravityMode(protocolSessionId, result, mode, requestedMode !== undefined);
        } catch (error) {
          await this.closeUnconfirmedAntigravityWorker(metadata.sessionId, protocolSessionId, cwd);
          throw error;
        }
      }
    } finally {
      this.loadingSessions.delete(protocolSessionId);
    }
    if (loadState.replayedTranscript) {
      this.sessionLoadReplays.set(protocolSessionId, {
        ...(loadState.lastTimestampedTranscriptAt !== undefined
          ? {
              lastTimestampedTranscriptAt:
                loadState.lastTimestampedTranscriptAt,
            }
          : {}),
      });
    }
    const runtimeCapabilities = this.captureRuntimeCapabilities({
      source: "session-load",
      result,
    });
    this.rememberSessionConfigOptions(protocolSessionId, result);
    this.rememberSessionModeMenu(protocolSessionId, result);
    this.rememberSessionMcpServers(metadata.sessionId, mcpRegistration, mcpServerWireConfigs);
    await Promise.resolve(mcpRegistration.bindThread?.(metadata.sessionId));
    const runtimeState = this.runtimeStateFromResponse(result, this.now());
    if (runtimeState) {
      this.updateSessionRuntimeState(metadata.sessionId, runtimeState, {
        touchActivity: false,
      });
      void Promise.resolve(
        this.options.onSessionRuntimeStateChange?.({
          fromSessionLoad: true,
          sessionId: metadata.sessionId,
          runtimeState,
        }),
      ).catch(() => undefined);
    }
    this.notifyRuntimeCapabilities({
      fromSessionLoad: true,
      sessionId: metadata.sessionId,
      runtimeCapabilities,
      runtimeState,
    });
    this.loadedSessionCwds.set(protocolSessionId, cwd);
    if (!metadata.hidden && !this.sessionsWithoutFaithfulReload.has(metadata.sessionId)) {
      this.rememberJobMonitorCatalog(metadata.sessionId, mcpRegistration, jobMonitorCreationEnabled, true);
    }
    this.rememberAgentToolCatalogKey(metadata.sessionId, agentToolCatalogKey);
    this.touchSession(metadata.sessionId);
    return result;
  }

  private async confirmAntigravityMode(
    protocolSessionId: string,
    loadResult: unknown,
    selectedMode: string,
    explicitSelection: boolean,
  ): Promise<unknown> {
    // Antigravity 1.5.15's new worker reports Default in session/load,
    // even after the previous worker acknowledged a different mode.
    const mode = normalizeAcpRuntimeCapabilities({
      value: loadResult,
      now: this.now(),
      source: "session-load",
    })?.configOptions?.find((option) => option.id === "mode" && option.category === "mode");
    if (!mode?.values.some((option) => option.value === selectedMode)) {
      if (explicitSelection) throw new Error(`Antigravity does not offer the "${selectedMode}" session mode.`);
      return loadResult;
    }
    if (mode.currentValue === selectedMode) return loadResult;
    const restored = await this.options.transport.request("session/set_config_option", {
      sessionId: protocolSessionId,
      configId: mode.id,
      value: selectedMode,
    });
    this.assertAntigravityModeConfirmed(restored, selectedMode, explicitSelection ? "apply" : "restore");
    const loaded = asRecord(loadResult);
    const legacyModes = asRecord(loaded?.modes);
    return {
      ...loaded,
      ...asRecord(restored),
      ...(legacyModes ? { modes: { ...legacyModes, currentModeId: selectedMode } } : {}),
    };
  }

  private assertAntigravityModeConfirmed(result: unknown, mode: string, action: "apply" | "restore"): void {
    if (this.runtimeStateFromResponse(result, this.now())?.configValues?.mode !== mode) {
      throw new Error(`Antigravity did not ${action} the "${mode}" session mode.`);
    }
  }

  private async closeUnconfirmedAntigravityWorker(
    sessionId: string,
    protocolSessionId: string,
    cwd: string,
  ): Promise<void> {
    const pending = this.idleClosedSessions.get(sessionId);
    try {
      if (!this.supportsSessionClose()) throw new Error("Agent does not advertise session/close");
      await this.options.transport.request("session/close", { sessionId: protocolSessionId }, ACP_SESSION_CLOSE_REQUEST_TIMEOUT_MS);
      this.loadedSessionCwds.delete(protocolSessionId);
      if (pending) pending.workerOpen = false;
    } catch (error) {
      // Retain both facts: archive and idle cleanup still own a live worker,
      // and the next request must confirm its mode before using it.
      this.loadedSessionCwds.set(protocolSessionId, cwd);
      if (pending) pending.workerOpen = true;
      else this.idleClosedSessions.set(sessionId, { closed: Promise.resolve(), workerOpen: true });
      this.touchSession(sessionId);
      acpClientLog.warn("could not close ACP worker after unconfirmed Antigravity mode", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private rememberSessionMcpServers(
    sessionId: string,
    registration: AcpMcpServerRegistration,
    wireConfigs: ReadonlyArray<{ name: string }>,
  ): void {
    const agentNames = wireConfigs.map((server) => server.name);
    const sent = new Set(agentNames);
    // A grant names a tool as the agent flattened it. When the servers behind
    // those names change, the same name can reach a different server.
    const previous = this.sessionMcpServers.get(sessionId);
    if (previous && !sameNames(previous.agentNames, agentNames)) {
      this.sessionMcpToolGrants.delete(sessionId);
    }
    this.sessionMcpServers.set(sessionId, {
      agentNames,
      registeredNames: new Set(registration.servers
        .map((server) => server.name)
        .filter((name) => sent.has(name))),
      ...(registration.hostApprovesToolCall
        ? { hostApprovesToolCall: registration.hostApprovesToolCall }
        : {}),
    });
  }

  private rememberAgentToolCatalogKey(sessionId: string, key: string | undefined): void {
    if (key === undefined) this.sessionAgentToolCatalogKeys.delete(sessionId);
    else this.sessionAgentToolCatalogKeys.set(sessionId, key);
  }

  private rememberJobMonitorCatalog(
    sessionId: string,
    registration: AcpMcpServerRegistration,
    enabled: boolean | undefined,
    fromLoad: boolean,
  ): void {
    if (enabled !== undefined && registration.readListedJobMonitorCreation) {
      const firstRegistration = !this.jobMonitorCatalogs.has(sessionId);
      this.jobMonitorCatalogs.set(sessionId, {
        enabled,
        readListed: registration.readListedJobMonitorCreation,
        fromLoad,
      });
      if (firstRegistration) {
        void this.options.onJobMonitorControlReady?.(sessionId).catch(() => undefined);
      }
    } else {
      this.jobMonitorCatalogs.delete(sessionId);
    }
  }

  private hasNativeBackgroundWork(sessionId: string): boolean {
    return this.grokBackgroundSessions.has(sessionId) || this.antigravityBackgroundCommands.has(sessionId);
  }

  /** Closing either provider's session stops its native background work. */
  private observeNativeBackgroundWork(sessionId: string, kind: string | undefined, update: Record<string, unknown>): void {
    if (this.options.backendId === "acp:grok" && kind === "background_tasks" && Array.isArray(update.tasks)) {
      const active = update.tasks.some((task: unknown) => {
        const status = asRecord(task)?.status;
        return status === "running" || status === "pending";
      });
      if (active) this.grokBackgroundSessions.add(sessionId);
      else this.grokBackgroundSessions.delete(sessionId);
    }
    if (this.options.backendId !== "acp:antigravity" || (kind !== "tool_call" && kind !== "tool_call_update")
      || typeof update.toolCallId !== "string") return;
    const active = this.antigravityBackgroundCommands.get(sessionId);
    if (update.name !== "run_command" && !active?.has(update.toolCallId)) return;
    if (update.status === "in_progress" || update.status === "pending") {
      const commands = active ?? new Set<string>();
      commands.add(update.toolCallId);
      this.antigravityBackgroundCommands.set(sessionId, commands);
    } else if (update.status === "completed" || update.status === "failed" || update.status === "cancelled") {
      active?.delete(update.toolCallId);
      if (active?.size === 0) this.antigravityBackgroundCommands.delete(sessionId);
    }
  }

  /**
   * Whether an open session's MCP servers advertise another catalog than the
   * current one, such as the full one after this member became contained,
   * and a close and load can give it the current one. Calls outside the
   * current catalog are refused either way; this only fixes what the model
   * is shown.
   */
  private agentToolCatalogIsStale(sessionId: string): boolean {
    const advertised = this.sessionAgentToolCatalogKeys.get(sessionId);
    if (advertised === undefined) return false;
    const current = this.options.agentToolCatalogKey?.();
    return current !== undefined
      && current !== advertised
      && this.supportsSessionClose()
      && this.runtimeCapabilities?.agentCapabilities?.loadSession === true
      && !this.sessionsWithoutFaithfulReload.has(sessionId)
      && this.loadedSessionCwds.has(this.protocolSessionIdFor(sessionId));
  }

  /**
   * Close and load a session whose catalog is stale, so the agent starts its
   * MCP servers again and lists the current tools. A close that fails keeps
   * the session as it was.
   */
  private async refreshAgentToolCatalog(sessionId: string): Promise<boolean> {
    const protocolSessionId = this.protocolSessionIdFor(sessionId);
    if (!this.loadedSessionCwds.has(protocolSessionId)
      || this.pendingPermissionRequests.has(sessionId)
      || this.loadingSessions.has(protocolSessionId)
      || this.suppressedControlPromptSessions.has(protocolSessionId)
      || this.hasNativeBackgroundWork(sessionId)) return false;
    acpClientLog.info("reloading ACP session for a new agent tool catalog", {
      backendId: this.options.backendId,
      sessionId,
    });
    if (!await this.closeIdleSession(sessionId)) return false;
    await this.reopenIdleClosedSession(sessionId);
    return true;
  }

  private async prepareJobMonitorCatalog(sessionId: string): Promise<void> {
    const catalog = this.jobMonitorCatalogs.get(sessionId);
    const readPreference = this.options.readJobMonitorCreationPreference;
    if (!catalog || !readPreference) return;
    const enabled = await readPreference(sessionId);
    if (catalog.enabled === enabled
      && !this.agentToolCatalogIsStale(sessionId)
      && (!catalog.fromLoad || catalog.readListed() === enabled)) return;
    if (this.hasNativeBackgroundWork(sessionId)) {
      throw new Error("Wait for the agent's background work to finish, then send the prompt again to refresh its Job Monitor tools.");
    }
    if (this.supportsJobMonitorControl(sessionId) && await this.refreshAgentToolCatalog(sessionId)) {
      const refreshed = this.jobMonitorCatalogs.get(sessionId);
      const currentPreference = await readPreference(sessionId);
      if (refreshed?.enabled === currentPreference && refreshed.readListed() === currentPreference
        && !this.agentToolCatalogIsStale(sessionId)) return;
    }
    throw new Error("The agent couldn't refresh its Job Monitor tools. Try sending the prompt again.");
  }

  private isSessionLoaded(metadata: AcpSessionMetadata): boolean {
    const cwd = metadata.cwd ?? process.cwd();
    const protocolSessionId = protocolSessionIdForMetadata(metadata);
    return (
      this.loadedSessionCwds.has(protocolSessionId) &&
      this.loadedSessionCwds.get(protocolSessionId) === cwd
    );
  }

  private async buildMcpServers(params: {
    cwd: string;
    sessionId?: string;
  }): Promise<AcpMcpServerRegistration> {
    const registration = await this.options.mcpServers?.({
      backendId: this.options.backendId,
      cwd: params.cwd,
      runtimeCapabilities: this.runtimeCapabilities,
      sessionId: params.sessionId,
    });
    return Array.isArray(registration)
      ? { servers: registration }
      : registration ?? { servers: [] };
  }

  private startTrackedTurn(sessionId: string, turnId: string): AcpActiveTurn {
    if (this.activeTurns.has(sessionId)) {
      throw new Error("A turn is already active for this ACP session.");
    }
    const activeTurn: AcpActiveTurn = {
      assistantText: "",
      turnId,
      promptGeneration: 1,
    };
    this.activeTurns.set(sessionId, activeTurn);
    this.touchSession(sessionId);
    this.updateSessionStatus(sessionId, "active");
    return activeTurn;
  }

  private requestPromptWithTerminalGuard(params: {
    protocolSessionId: string;
    prompt: AcpPromptContentBlock[];
    sessionId: string;
    turnId: string;
    agentInstructions?: string;
    readAgentMemory?: () => Promise<string | undefined>;
    onDispatch?: () => void;
  }): Promise<unknown> {
    const activeTurn = this.activeTurns.get(params.sessionId);
    const terminalResponseGuard = new Promise<never>((_resolve, reject) => {
      if (!activeTurn || activeTurn.turnId !== params.turnId) return;
      activeTurn.onTerminalUpdate = () => {
        if (activeTurn.terminalResponseGraceStarted) return;
        activeTurn.terminalResponseGraceStarted = true;
        const timer = setTimeout(() => {
          if (this.activeTurns.get(params.sessionId) !== activeTurn) return;
          const displayName = this.options.agentDisplayName?.trim() || "ACP agent";
          reject(new AcpPromptNotClosedError(
            `${displayName} reported that the turn ended, but its ACP prompt request did not close. The provider connection may be unavailable.`,
          ));
        }, ACP_TERMINAL_RESPONSE_GRACE_MS);
        timer.unref?.();
      };
    });
    const cancelled = { stopReason: "cancelled" };
    let cancelledBeforePrompt = false;
    const localCancellation = new Promise<typeof cancelled>((resolve) => {
      if (activeTurn) activeTurn.cancelBeforePrompt = () => {
        cancelledBeforePrompt = true;
        resolve(cancelled);
      };
    });
    // The tracked turn prevents a new idle close. Wait for one already in
    // flight before using the session, then check the catalog at dispatch.
    const reload = this.reloadBeforeRequest(params.sessionId);
    const sendPrompt = async () => {
      if (reload) await reload;
      if (cancelledBeforePrompt) return cancelled;
      // The agent keeps the block in the session's history, so a session
      // loaded again (after an idle close or an app restart) is not sent it
      // a second time. The stored record says what this agent session holds.
      const instructions = params.agentInstructions;
      const digest = instructions === undefined
        ? undefined
        : agentInstructionsDigest(params.protocolSessionId, instructions);
      const sendInstructions = instructions !== undefined
        && digest !== this.options.store.getSession(
          this.options.backendId,
          params.sessionId,
        )?.agentInstructionsDigest;
      const memory = params.readAgentMemory ? await params.readAgentMemory() : undefined;
      if (cancelledBeforePrompt) return cancelled;
      if (this.jobMonitorCatalogs.has(params.sessionId)) {
        await this.prepareJobMonitorCatalog(params.sessionId);
      } else if (this.agentToolCatalogIsStale(params.sessionId)) {
        await this.refreshAgentToolCatalog(params.sessionId);
      }
      if (cancelledBeforePrompt) return cancelled;
      this.assertPromptAccess(params.sessionId);
      params.onDispatch?.();
      if (activeTurn) {
        activeTurn.cancelBeforePrompt = undefined;
        activeTurn.sentAgentMemory = Boolean(memory);
      }
      const result = await this.options.transport.request(
        "session/prompt",
        {
          sessionId: params.protocolSessionId,
          prompt: [
            ...(sendInstructions ? textPrompt(buildAcpAgentInstructionBlock(instructions)) : []),
            ...params.prompt,
            ...(memory ? textPrompt(memory) : []),
          ],
        },
        ACP_TURN_PROMPT_REQUEST_TIMEOUT_MS,
      );
      // Recorded once the agent has answered the prompt. A prompt that fails,
      // or that compacted the block away, leaves the session due it again.
      if (sendInstructions && !activeTurn?.compacted) {
        this.recordDeliveredAgentInstructions(params.sessionId, digest);
      }
      return result;
    };
    return Promise.race([
      sendPrompt(),
      terminalResponseGuard,
      localCancellation,
    ]);
  }

  private finishTrackedTurn(
    sessionId: string,
    completedAt: number,
    status: "completed" | "interrupted" = "completed",
    workspaceContextDelivered?: boolean,
  ): {
    assistantText: string;
    replay: AppServerThreadReplay;
    turnId?: string;
  } {
    const activeTurn = this.activeTurns.get(sessionId);
    this.activeTurns.delete(sessionId);
    // The idle clock starts when the turn ends, not when it began.
    this.touchSession(sessionId);
    const replay = this.normalizerFor(sessionId).recordTurnFinished(
      activeTurn?.turnId,
      completedAt,
      status,
    );
    // Use the existing idle write so remembering one accepted context block
    // does not introduce another per-turn commit.
    this.updateSessionStatus(sessionId, "idle", this.now(), { workspaceContextDelivered });
    return {
      assistantText: activeTurn?.assistantText ?? "",
      replay,
      turnId: activeTurn?.turnId,
    };
  }

  private missingPromptResponseError(
    sessionId: string,
    result: unknown,
  ): Error | undefined {
    if (promptWasCancelled(result)) {
      return;
    }
    const activeTurn = this.activeTurns.get(sessionId);
    if (activeTurn?.assistantText.trim()) {
      return;
    }

    const displayName = this.options.agentDisplayName?.trim() || "ACP agent";
    const version = this.runtimeCapabilities?.agentInfo?.version?.trim();
    if (this.options.backendId === "acp:kimi") {
      return new Error(
        `${displayName} ended the turn without a response.${
          version ? ` Kimi Code CLI ${version}` : " This Kimi Code CLI"
        } may be out of date or incompatible with the selected model. Update Kimi, refresh the model catalog, and try again.`,
      );
    }
    return new Error(
      `${displayName} ended the turn without a response. Refresh the provider model catalog and try again.`,
    );
  }

  /**
   * Context only grows between compactions, so a live fill below half the
   * last one the session reported means the agent compacted. Kimi, Qwen and
   * Gemini each report the current fill as `used`.
   */
  private contextFillHalved(
    sessionId: string,
    protocolSessionId: string,
    update: Record<string, unknown>,
    updateKind: string | undefined,
  ): boolean {
    if (updateKind !== "usage_update") return false;
    const used = update.used;
    if (typeof used !== "number" || !Number.isFinite(used)) return false;
    const previous = this.sessionContextFill.get(sessionId);
    this.sessionContextFill.set(sessionId, { protocolSessionId, used });
    return previous?.protocolSessionId === protocolSessionId
      && used < previous.used / 2;
  }

  /**
   * One write per delivered block (the first delivery and each edit) and per
   * compaction that clears the record. An unchanged record is not written.
   */
  private recordDeliveredAgentInstructions(
    sessionId: string,
    digest: string | undefined,
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata || metadata.agentInstructionsDigest === digest) {
      return;
    }
    const { agentInstructionsDigest: _previous, ...rest } = metadata;
    this.options.store.upsertSession({
      ...rest,
      ...(digest ? { agentInstructionsDigest: digest } : {}),
    });
  }

  private recordPromptFailure(
    sessionId: string,
    turnId: string,
    error: unknown,
  ): AppServerThreadReplay {
    const message = errorMessage(error);
    const receivedAt = this.now();
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (metadata) {
      this.options.store.upsertSession({
        ...metadata,
        lastError: message,
        status: "idle",
        updatedAt: Math.max(metadata.updatedAt, receivedAt),
      });
    }
    this.appendHistoryUpdate(sessionId, receivedAt, {
      kind: "pwragent_turn_failed",
      turnId,
      error: message,
    });
    return this.normalizerFor(sessionId).recordTurnFailed({
      sessionId,
      turnId,
      error: message,
      receivedAt,
    });
  }

  private appendHistoryUpdate(
    sessionId: string,
    receivedAt: number,
    update: Record<string, unknown>,
  ): void {
    const verifiedReplay = this.sessionLoadReplays.get(
      this.protocolSessionIdFor(sessionId),
    );
    // Keep a durable fallback until this exact session has successfully
    // replayed timestamped provider history. An advertised capability alone
    // cannot prove that session/load returned usable transcript history, and
    // providers such as Kimi still need the local timestamps they omit.
    if (verifiedReplay?.lastTimestampedTranscriptAt !== undefined) {
      if (this.options.backendId !== "acp:antigravity") return;
      const identity = readAntigravityReplayPromptIdentity({ type: "update", receivedAt, update });
      if (!identity) return;
      // The provider owns the transcript. Keep only the metadata required
      // to recognize local prompt boundaries on its next replay.
      update = {
        kind: "pwragent_antigravity_prompt_identity",
        turnId: identity.turnId,
        messageId: identity.steerMessageId,
        textDigest: identity.textDigest,
      };
    }
    this.options.rolloutStore?.appendUpdate({
      backendId: this.options.backendId,
      sessionId,
      receivedAt,
      update,
    });
  }

  private updateSessionStatus(
    sessionId: string,
    status: AcpSessionMetadata["status"],
    receivedAt = this.now(),
    options: AcpSessionMetadataUpdateOptions & { workspaceContextDelivered?: boolean } = {},
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      status,
      ...(options.workspaceContextDelivered ? { antigravityWorkspaceContextDelivered: true } : {}),
      updatedAt:
        options.touchActivity === false
          ? metadata.updatedAt
          : Math.max(metadata.updatedAt, receivedAt),
    });
  }

  private updateSessionTitleFromAcpUpdate(
    sessionId: string,
    update: Record<string, unknown>,
    receivedAt: number,
    options: AcpSessionMetadataUpdateOptions = {},
  ): string | undefined {
    const title = stripAgentMemoryChunk(readAcpTopicTitle(update) ?? "").text;
    if (!title) {
      return undefined;
    }
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata || metadata.title === title) {
      return undefined;
    }
    const currentTitleSource =
      metadata.titleSource ??
      (metadata.title === "ACP session" || !metadata.title.trim()
        ? "fallback"
        : "derived");
    if (currentTitleSource !== "fallback") {
      return undefined;
    }
    this.options.store.upsertSession({
      ...metadata,
      title,
      titleSource: "derived",
      updatedAt:
        options.touchActivity === false
          ? metadata.updatedAt
          : Math.max(metadata.updatedAt, receivedAt),
    });
    return title;
  }

  private rememberSessionIds(metadata: AcpSessionMetadata): void {
    this.options.assertSessionOwner?.(metadata.sessionId);
    const protocolSessionId = protocolSessionIdForMetadata(metadata);
    this.agentSessionIdsByAppSessionId.set(metadata.sessionId, protocolSessionId);
    this.appSessionIdsByAgentSessionId.set(protocolSessionId, metadata.sessionId);
    if (metadata.hidden !== true) {
      this.retainableSessionIds.add(metadata.sessionId);
    }
  }

  private protocolSessionIdFor(sessionId: string): string {
    this.options.assertSessionOwner?.(sessionId);
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (metadata) {
      this.rememberSessionIds(metadata);
      return protocolSessionIdForMetadata(metadata);
    }
    return this.agentSessionIdsByAppSessionId.get(sessionId) ?? sessionId;
  }

  private assertPromptAccess(sessionId: string): void {
    const fullAccess = this.options.antigravityFullAccess;
    if (fullAccess === undefined) return;
    this.options.assertSessionOwner?.(sessionId);
    const session = this.options.store.getSession(this.options.backendId, sessionId);
    if (!session || fullAccess !== (acpSessionExecutionMode(session) === "full-access")) {
      throw new Error("The Antigravity process does not match the thread's applied access. Try again.");
    }
  }

  private appSessionIdFor(protocolSessionId: string): string {
    return this.appSessionIdsByAgentSessionId.get(protocolSessionId) ?? protocolSessionId;
  }
}

function protocolSessionIdForMetadata(metadata: AcpSessionMetadata): string {
  return metadata.agentSessionId ?? metadata.sessionId;
}

function withAcpSessionUpdateEnvelopeMetadata(
  update: Record<string, unknown> | undefined,
  envelopeMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!update || !envelopeMeta) {
    return update;
  }
  const updateMeta = asRecord(update._meta);
  return {
    ...update,
    _meta: {
      ...envelopeMeta,
      ...updateMeta,
    },
  };
}

function readUpdateKind(update: Record<string, unknown>): string | undefined {
  const kind =
    update.sessionUpdate ?? update.session_update ?? update.kind ?? update.type;
  return typeof kind === "string" ? kind : undefined;
}

function isAcpSessionReplayUpdate(update: Record<string, unknown>): boolean {
  const meta = asRecord(update._meta);
  return meta?.isReplay === true || meta?.is_replay === true;
}

function isProviderTranscriptReplayUpdate(
  update: Record<string, unknown>,
): boolean {
  if (!isTranscriptReplayUpdate(update)) {
    return false;
  }
  return (
    readUpdateKind(update) !== "user_message_chunk" ||
    !isAcpUserBoilerplateMessage(readUpdateText(update))
  );
}

function isConversationHistoryUpdate(update: Record<string, unknown>): boolean {
  const kind = readUpdateKind(update);
  return (
    kind === "pwragent_user_prompt" ||
    kind === "pwragent_steered_user_prompt" ||
    kind === "user_message_chunk" ||
    kind === "agent_message_chunk" ||
    kind === "agent_thought_chunk"
  );
}

function isTranscriptReplayUpdate(update: Record<string, unknown>): boolean {
  const kind = readUpdateKind(update);
  return (
    isConversationHistoryUpdate(update) ||
    kind === "plan" ||
    kind === "tool_call" ||
    kind === "tool_call_update" ||
    kind === "file" ||
    kind === "terminal" ||
    kind === "turn_completed" ||
    kind === "turn_finished" ||
    kind === "pwragent_turn_failed"
  );
}

function readUpdateText(update: Record<string, unknown>): string | undefined {
  if (typeof update.text === "string") {
    return update.text;
  }
  if (typeof update.outputText === "string") {
    return update.outputText;
  }
  if (typeof update.output_text === "string") {
    return update.output_text;
  }
  return readAcpContentText(update.content);
}

function normalizeAvailableCommandsUpdate(
  update: Record<string, unknown>,
  backend: AcpBackendId,
): AppServerAvailableCommandSummary[] {
  const rawCommands = Array.isArray(update.availableCommands)
    ? update.availableCommands
    : Array.isArray(update.available_commands)
      ? update.available_commands
      : [];
  const commands = new Map<string, AppServerAvailableCommandSummary>();

  for (const rawCommand of rawCommands) {
    const command = asRecord(rawCommand);
    const name = readNonEmptyString(command, "name");
    if (!name) {
      continue;
    }
    const description = readNonEmptyString(command, "description");
    const aliases = readStringArray(command?.aliases);
    // ACP's command `input` is `{ hint }` (v2 adds `type: "text"`). Qwen
    // sends an empty hint for commands that take nothing.
    const argumentHint = readNonEmptyString(asRecord(command?.input), "hint");
    commands.set(name, {
      name,
      backend,
      scope: "session",
      source: "provider",
      ...(description ? { description } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(argumentHint ? { argumentHint } : {}),
    });
  }

  return [...commands.values()];
}

function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  const message = String(error).trim();
  return message || "Turn failed.";
}

function acpSessionThreadStatus(
  status: AcpSessionMetadata["status"],
  fallback: AppServerThreadReplay["threadStatus"],
): AppServerThreadReplay["threadStatus"] {
  return status === "active" || status === "idle" || status === "unknown"
    ? status
    : fallback;
}

function mergeAcpRuntimeState(
  existing: BackendAcpSessionRuntimeState | undefined,
  update: BackendAcpSessionRuntimeState,
): BackendAcpSessionRuntimeState {
  return {
    ...existing,
    ...update,
    configValues: {
      ...(existing?.configValues ?? {}),
      ...(update.configValues ?? {}),
    },
  };
}

type AcpPermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
};

function readPermissionOptions(value: unknown): AcpPermissionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((option) => {
    const record = asRecord(option);
    const optionId = record?.optionId;
    if (!record || typeof optionId !== "string" || !optionId.trim()) {
      return [];
    }
    const normalized: AcpPermissionOption = { optionId };
    if (typeof record.name === "string") {
      normalized.name = record.name;
    }
    if (typeof record.kind === "string") {
      normalized.kind = record.kind;
    }
    return [normalized];
  });
}

function approvalRequesterNameForOptions(options: Pick<
  AcpAgentClientOptions,
  "agentDisplayName" | "backendId"
>): string {
  const configured = options.agentDisplayName?.trim();
  if (configured) {
    return configured;
  }
  const backendName = options.backendId
    .replace(/^acp:/, "")
    .split(/[-_:]+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
    .trim();
  return backendName || "ACP agent";
}

function permissionPrompt(
  requesterName: string,
  title: string,
  toolCall: Record<string, unknown>,
): string {
  const contentText = readToolCallText(toolCall.content);
  if (
    contentText &&
    (!readAcpToolContentCommand(toolCall) || isApprovalPromptText(contentText))
  ) {
    return contentText;
  }
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : undefined;
  return kind
    ? `${requesterName} wants to run ${kind}: ${title}`
    : `${requesterName} wants to run ${title}`;
}

function isApprovalPromptText(text: string): boolean {
  return /^Requesting approval to Running:\s*/imu.test(text);
}

function mcpPermissionPrompt(
  requesterName: string,
  toolName: string,
  toolCall: Record<string, unknown>,
): string {
  const title = readToolCallText(toolCall.title);
  const content = readToolCallText(toolCall.content);
  const details = [title, content].filter((text) =>
    text && text !== toolName && text !== `Run ${toolName}`,
  );
  return [
    `${requesterName} wants to use an MCP tool.`,
    ...new Set(details),
  ].join("\n\n");
}

function readToolCallText(value: unknown): string | undefined {
  return readAcpToolText(value);
}

function permissionCommand(
  title: string,
  toolCall: Record<string, unknown>,
): string {
  return readAcpToolCommand(toolCall) ?? title;
}

function permissionOutcomeFromResponse(
  response: unknown,
  options: AcpPermissionOption[],
): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  const decision = asRecord(response)?.decision;
  if (typeof decision !== "string") {
    return cancelledPermissionOutcome();
  }
  if (decision === "cancel") {
    return cancelledPermissionOutcome();
  }
  const optionId = selectPermissionOptionId(decision, options);
  return optionId
    ? { outcome: { outcome: "selected", optionId } }
    : cancelledPermissionOutcome();
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...new Set(left)].sort();
  const sortedRight = [...new Set(right)].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((name, index) => name === sortedRight[index]);
}

function allowOncePermissionOptionId(options: AcpPermissionOption[]): string | undefined {
  return options.find((option) => option.kind === "allow_once")?.optionId;
}

/** Offers "Allow for this thread" when the agent can allow once but never always. */
function withThreadToolGrantOption(options: AcpPermissionOption[]): AcpPermissionOption[] {
  if (!allowOncePermissionOptionId(options) || options.some((option) => option.kind === "allow_always")) {
    return options;
  }
  const grant: AcpPermissionOption = {
    optionId: ACP_THREAD_TOOL_GRANT_OPTION_ID,
    name: "Allow for this thread",
    kind: "allow_always",
  };
  const firstReject = options.findIndex((option) => option.kind?.startsWith("reject"));
  return firstReject < 0
    ? [...options, grant]
    : [...options.slice(0, firstReject), grant, ...options.slice(firstReject)];
}

/** The operator chose the thread grant PwrAgent added to this request. */
function isThreadToolGrantResponse(
  response: unknown,
  request: AppServerPendingRequestNotification,
): boolean {
  const offered = Array.isArray(request.params.acpPermissionOptions)
    && request.params.acpPermissionOptions.some((option) =>
      asRecord(option)?.optionId === ACP_THREAD_TOOL_GRANT_OPTION_ID);
  if (!offered) return false;
  const decision = asRecord(response)?.decision;
  return typeof decision === "string"
    && [ACP_THREAD_TOOL_GRANT_OPTION_ID, "accept_for_session", "allow_always"]
      .includes(decision.toLowerCase());
}

function cancelledPermissionOutcome(): { outcome: { outcome: "cancelled" } } {
  return { outcome: { outcome: "cancelled" } };
}

function selectPermissionOptionId(
  decision: string,
  options: AcpPermissionOption[],
): string | undefined {
  const normalizedDecision = decision.toLowerCase();
  const exact = options.find((option) =>
    [option.optionId, option.name, option.kind]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase() === normalizedDecision),
  );
  if (exact) {
    return exact.optionId;
  }

  if (
    normalizedDecision === "approve" ||
    normalizedDecision === "accept" ||
    normalizedDecision === "allow"
  ) {
    return (
      options.find((option) => option.kind === "allow_once") ??
      options.find((option) => option.kind === "allow_always") ??
      options.find((option) => option.name?.toLowerCase().includes("allow"))
    )?.optionId;
  }

  if (
    normalizedDecision === "accept_for_session" ||
    normalizedDecision === "allow_always"
  ) {
    return (
      options.find((option) => option.kind === "allow_always") ??
      options.find((option) =>
        option.name?.toLowerCase().includes("always allow"),
      )
    )?.optionId;
  }

  if (normalizedDecision === "accept_with_execpolicy_amendment") {
    return (
      options.find(
        (option) =>
          option.kind === "allow_always" &&
          option.optionId.toLowerCase().includes("command"),
      ) ??
      options.find((option) => option.kind === "allow_always")
    )?.optionId;
  }

  if (
    normalizedDecision === "decline" ||
    normalizedDecision === "reject" ||
    normalizedDecision === "deny"
  ) {
    return (
      options.find((option) => option.kind === "reject_once") ??
      options.find((option) => option.name?.toLowerCase().includes("reject"))
    )?.optionId;
  }

  return undefined;
}

function textPrompt(text: string): AcpPromptContentBlock[] {
  return [{ type: "text", text }];
}

/** PwrAgent stopped waiting for a prompt the agent reported finishing. */
class AcpPromptNotClosedError extends Error {}

/**
 * True when PwrAgent gave up on a prompt the agent never answered: the
 * agent's request is still open on its side. A JSON-RPC error response, or a
 * closed transport, means the agent is done with it.
 */
function promptMayStillBeRunning(error: unknown): boolean {
  return error instanceof AcpPromptNotClosedError
    || (error instanceof Error
      && error.message.startsWith("json-rpc timeout: session/prompt"));
}

function promptWasCancelled(result: unknown): boolean {
  const resultRecord = asRecord(result);
  return resultRecord?.stopReason === "cancelled"
    || resultRecord?.stop_reason === "cancelled";
}

function isAntigravityPromptDetach(result: unknown): boolean {
  const record = asRecord(result);
  // The captured handoff is end_turn with no usage. A naturally completed
  // Antigravity prompt returns usage even when a second prompt is in flight.
  return record?.stopReason === "end_turn" && !Object.hasOwn(record, "usage");
}

function readAntigravityReplayPromptIdentity(record: AcpRolloutRecord): AcpReplayPromptIdentity | undefined {
  const { update, receivedAt } = record;
  const turnId = typeof update.turnId === "string" ? update.turnId : undefined;
  if (!turnId) return undefined;
  const kind = readUpdateKind(update);
  const steerMessageId = typeof update.messageId === "string" ? update.messageId : undefined;
  if (kind === "pwragent_antigravity_prompt_identity" && typeof update.textDigest === "string") {
    return { turnId, receivedAt, steerMessageId, textDigest: update.textDigest };
  }
  if ((kind === "pwragent_user_prompt" || kind === "pwragent_steered_user_prompt")
    && typeof update.prompt === "string") {
    return { turnId, receivedAt, steerMessageId, textDigest: acpReplayPromptTextDigest(update.prompt) };
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readFiniteNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBooleanValue(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function readStringValue(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeRewindTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Identifies the instruction text an agent session was sent. Empty text has
 * no digest, which is also what a session that was sent nothing records. The
 * session id is part of it, so a thread bound to a new agent session, which
 * starts with an empty history, is sent the block again.
 */
function agentInstructionsDigest(
  protocolSessionId: string,
  instructions: string,
): string | undefined {
  return instructions
    ? createHash("sha256").update(`${protocolSessionId}\0${instructions}`).digest("hex")
    : undefined;
}
