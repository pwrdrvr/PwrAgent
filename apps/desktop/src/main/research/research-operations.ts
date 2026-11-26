import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAppServerBackendKind } from "@pwragent/shared/contracts/navigation";
import {
  type PrepareResearchRequest,
  type ResearchChanges,
  type ResearchChangesRequest,
  type ResearchEventPage,
  type ResearchEventsRequest,
  type ResearchItemContext,
  type ResearchItemReadRequest,
  type ResearchSearchPage,
  type ResearchSearchRequest,
  type ResearchSnapshot,
  type ResearchSnapshotRequest,
  type ResearchThread,
  type ResearchUpdateReceipt,
  type ResearchUpdateRequest,
  type ResearchWorkRequest,
} from "@pwragent/shared/research";
import type {
  MathosSwarmsResult,
  ResearchHarnessCheck,
  ResearchHarnessReconcileRequest,
  ResearchHarnessRequest,
  ResearchHarnessStatus,
} from "@pwragent/shared/research-harness";
import { researchToolsOffered, researchToolSurface } from "../agent-tools/pwragent-research-agent-tools";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getMainLogger } from "../log";
import {
  getResearchHarnessService,
  getResearchService,
  listResearchMathosSwarms,
  researchHarnessPlatformKeyStored,
  researchHarnessStatus,
} from "./research-runtime";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";

const researchOperationsLog = getMainLogger("pwragent:research");

export function requireResearchEnabled(): void {
  if (getDesktopSettingsService().resolveResearchEnabled?.() !== true) {
    throw new Error("Research runs are disabled. Enable Research runs in Settings → Experimental.");
  }
}

export function validateResearchThread(request: ResearchThread): void {
  requireResearchEnabled();
  if (
    !request
    || typeof request.backend !== "string"
    || !isAppServerBackendKind(request.backend)
    || typeof request.threadId !== "string"
    || !request.threadId.trim()
  ) {
    throw new Error("Choose a local thread");
  }
}

/** The canonical workspace the owner binds for this thread's Harness evidence. */
async function harnessWorkspace(request: ResearchThread): Promise<string | undefined> {
  const cwd = await getDesktopBackendRegistry().resolveThreadWorkspaceCwd(request.backend, request.threadId);
  return cwd ? await realpath(cwd) : undefined;
}

/**
 * Owner-local Research operations shared by local IPC and incoming Federation
 * RPCs. Every call validates against this instance's own settings and services,
 * and Harness credentials never leave this process.
 */
export const localResearchOperations = {
  snapshot(request: ResearchSnapshotRequest): ResearchSnapshot {
    validateResearchThread(request);
    if (request.runId !== undefined && (typeof request.runId !== "string" || request.runId.length > 300)) {
      throw new Error("Invalid research run");
    }
    return getResearchService().snapshot({
      backend: request.backend,
      threadId: request.threadId,
      ...(request.runId ? { runId: request.runId } : {}),
    });
  },

  changes(request: ResearchChangesRequest): ResearchChanges {
    validateResearchThread(request);
    if (typeof request.runId !== "string" || request.runId.length > 300) {
      throw new Error("Invalid research run");
    }
    return getResearchService().changes(request.runId, request.sinceRevision, request.after, {
      backend: request.backend,
      threadId: request.threadId,
      kind: "operator",
    });
  },

  events(request: ResearchEventsRequest): ResearchEventPage {
    validateResearchThread(request);
    if (typeof request.runId !== "string" || !request.range || typeof request.range !== "object") {
      throw new Error("Invalid research activity range");
    }
    const { beforeSeq, afterSeq, limit } = request.range;
    return getResearchService().readEvents(request.runId, { beforeSeq, afterSeq, limit }, {
      backend: request.backend,
      threadId: request.threadId,
      kind: "operator",
    });
  },

  search(request: ResearchSearchRequest): ResearchSearchPage {
    validateResearchThread(request);
    return getResearchService().search(request.runId, request.query, {
      backend: request.backend,
      threadId: request.threadId,
      kind: "operator",
    });
  },

  readItem(request: ResearchItemReadRequest): ResearchItemContext {
    validateResearchThread(request);
    return getResearchService().readItem(request.runId, request.itemId, {
      backend: request.backend,
      threadId: request.threadId,
      kind: "operator",
    });
  },

  async work(request: ResearchWorkRequest): Promise<ResearchItemContext> {
    validateResearchThread(request);
    if (!request.command || request.command.action !== "work") {
      throw new Error("Supply an item work command");
    }
    const actor = { backend: request.backend, threadId: request.threadId, kind: "operator" } as const;
    await getResearchService().work(request.runId, `operator:${request.requestId}`, request.command, actor);
    return getResearchService().readItem(request.runId, request.command.itemId, actor);
  },

  prepare(request: PrepareResearchRequest): { intentId: string } {
    validateResearchThread(request);
    // The coordinator must be offered research_start, or the request would only expire.
    const settings = getDesktopSettingsService();
    if (!researchToolsOffered(researchToolSurface(request.backend), {
      enabled: true,
      codexToolDiscovery: () => settings.resolveCodexToolDiscovery?.() !== false,
    })) {
      throw new Error("Codex threads need Codex Tool Discovery to start research. Turn it on in Settings → Experimental.");
    }
    return getResearchService().prepare(request);
  },

  withdraw(request: ResearchThread): void {
    validateResearchThread(request);
    getResearchService().withdraw(request);
  },

  async update(request: ResearchUpdateRequest): Promise<ResearchUpdateReceipt> {
    validateResearchThread(request);
    if (
      typeof request.runId !== "string"
      || typeof request.requestId !== "string"
      || !request.command
      || typeof request.command !== "object"
    ) {
      throw new Error("Invalid research update");
    }
    // A receipt only: the items the command changed reach the window by delta.
    const key = `operator:${request.requestId}`;
    const run = await getResearchService().update(request.runId, key, request.command, {
      backend: request.backend,
      threadId: request.threadId,
      kind: "operator",
    });
    // Only a revision request has a delivery to report.
    const delivery = request.command.action === "review" && request.command.decision === "revision_requested"
      ? getResearchService().revisionDelivery(run.id, key)
      : undefined;
    return { runId: run.id, revision: run.revision, status: run.status, ...(delivery ? { delivery } : {}) };
  },

  async harnessStatus(request: ResearchThread): Promise<ResearchHarnessStatus> {
    validateResearchThread(request);
    return researchHarnessStatus(await harnessWorkspace(request), process.env, await researchHarnessPlatformKeyStored());
  },

  async harnessCheck(request: ResearchThread): Promise<ResearchHarnessCheck> {
    validateResearchThread(request);
    // A check binds no evidence, so a thread without a directory still runs the bridge somewhere neutral.
    return await getResearchHarnessService().check(await harnessWorkspace(request) ?? await realpath(tmpdir()));
  },

  async harnessStart(request: ResearchHarnessRequest): Promise<ResearchUpdateReceipt> {
    validateResearchThread(request);
    const workspace = await harnessWorkspace(request);
    if (!workspace) throw new Error("Harness research requires this thread's originating workspace");
    const run = await getResearchHarnessService().start(request, workspace);
    return { runId: run.id, revision: run.revision, status: run.status };
  },

  async harnessReconcile(request: ResearchHarnessReconcileRequest): Promise<ResearchUpdateReceipt> {
    validateResearchThread(request);
    if (typeof request.runId !== "string" || request.runId.length > 300) {
      throw new Error("Invalid research run");
    }
    const run = await getResearchHarnessService().reconcile(request.runId, {
      backend: request.backend,
      threadId: request.threadId,
      kind: "operator",
    });
    return { runId: run.id, revision: run.revision, status: run.status };
  },

  async listMathosSwarms(_request?: Record<string, never>): Promise<MathosSwarmsResult> {
    requireResearchEnabled();
    const result = await listResearchMathosSwarms();
    if (!result.ok) researchOperationsLog.warn("MathOS swarm listing failed", { error: result.error });
    return result;
  },
};
