import type { JsonRpcConnectionOptions, JsonRpcTransport } from "@pwrdrvr/agent-transport";
import type { LinkedDirectorySummary } from "@pwragent/shared";
import type { SandboxPolicy } from "@pwrdrvr/codex-app-server-protocol/v2";

export type CodexClientLogger = NonNullable<JsonRpcConnectionOptions["logger"]>;
export type CodexAppServerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrPreview: string[];
};
export type CodexAppServerProcessInfo = { pid: number; startedAt: number };
export type CodexClientTransport = JsonRpcTransport & {
  getProcessInfo?: () => CodexAppServerProcessInfo | undefined;
  takeLastStopReport?: () => { descendants: number; orphansReaped: number } | undefined;
};
export type CodexRecoveryBlockingTurn = { threadId: string; turnId?: string };
export type CodexInvalidResponseMessageIdRecoveryResult = {
  backupPath: string;
  removedMessageIdCount: number;
  rolloutPath: string;
  threadId: string;
};
export type ThreadDirectoryEnrichment = {
  linkedDirectories: LinkedDirectorySummary[];
  observedGitBranch?: string;
};
export type DirectoryEnrichmentCaller =
  | "thread-list" | "selected-thread" | "missing-worktree-backfill" | "explicit-enrichment" | "direct";

type ListingFields = {
  caller?: string;
  page?: number;
  attempt?: number;
  reason?: string;
  provider?: "codex";
  archived?: boolean;
};
export type CodexListingDiagnostics = {
  trace<T>(stage: "provider" | "provider-rpc", fields: ListingFields, operation: () => Promise<T>): Promise<T>;
  link(stage: "provider", phase: "coalesced", object: object, fields: ListingFields): void;
};

/** Host effects remain outside the protocol client and are scoped to one client. */
export type CodexClientHost = {
  createTransport: (callbacks: {
    onAuthenticationRejected: (home: string) => void;
    onUnexpectedExit: (exit: CodexAppServerExit) => void;
  }) => CodexClientTransport;
  clientInfo: { name: string; title: string };
  onRequestFailure?: (error: unknown) => void;
  logger: CodexClientLogger;
  rpcLogger: CodexClientLogger;
  listingDiagnostics: CodexListingDiagnostics;
  authState: {
    isBlocked(home: string): boolean;
    assertAvailable(home: string): void;
  };
  signInRequiredMessage: string;
  buildShellEnvironment: (env: NodeJS.ProcessEnv, bundledToolsDirectory?: string) => NodeJS.ProcessEnv;
  buildSandboxPolicy?: (sandbox?: string, cwd?: string) => SandboxPolicy | undefined;
  enrichThreadDirectory: (projectKey?: string, caller?: DirectoryEnrichmentCaller) => Promise<ThreadDirectoryEnrichment>;
  sampleAppServerProcessTree: (process: CodexAppServerProcessInfo) => Promise<{
    childProcessCount?: number;
    openFdCount?: number;
  }>;
  /** Only desktop supplies its narrowly authorized repair at its original path. */
  invalidResponseMessageIdRecovery?: {
    isFailure: (error: unknown) => boolean;
    repair: (params: {
      codexHome: string;
      forkLineageThreadIds?: string[];
      rolloutPath: string;
      threadId: string;
    }) => Promise<CodexInvalidResponseMessageIdRecoveryResult>;
  };
};
