import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { resolveDecisionModelSettings } from "@pwragent/shared/decision-models";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { threadDecisionBatchDirectory } from "../app-server/thread-assets";
import {
  isDecisionProviderEnabled,
  readSystemOneTarget,
  resolveDefaultDecisionProvider,
  type DecisionSettingsReader,
} from "./decision-provider-targets";
import type { PwrAgentOpenAIDecisionsHandler } from "../agent-tools/pwragent-openai-decisions-agent-tools";
import { getMainLogger } from "../log";
import { resolveActiveProfileName } from "../profile";
import type { OpenAIDecisionRegistryStorage } from "../storage/openai-decision-store";
import { createOpenAIDecisionStorage } from "../storage/desktop-runtime-storage";
import { OpenAIDecisionsService, type OpenAIDecisionsServiceOptions } from "./openai-decisions-service";

const openAIDecisionsLog = getMainLogger("pwragent:openai-decisions");

let flushPendingUsage: (() => Promise<void>) | undefined;

/**
 * What the thread's Decisions tab and Settings → AI Providers → Decisions
 * read and do, on this owner's decisions service.
 */
export type OpenAIDecisionsRail = Pick<
  OpenAIDecisionsService,
  | "railSnapshot"
  | "railActiveBatches"
  | "railBatchPage"
  | "operatorBatchAction"
  | "railResultsFile"
  | "profileDecisions"
  | "deleteProfileDecision"
>;

let rail: OpenAIDecisionsRail | undefined;

/** The Decisions tab's view of this owner's decisions, once the handler is installed. */
export function getOpenAIDecisionsRail(): OpenAIDecisionsRail | undefined {
  return rail;
}

/**
 * Cancels running decision batches, then writes batched decision usage
 * before the profile database closes, and writes any request still in
 * flight as soon as it finishes.
 */
export async function flushOpenAIDecisionsUsage(): Promise<void> {
  await flushPendingUsage?.();
}

/**
 * Builds the decisions tool handler for this owner. The key is read from the
 * settings secret store on each invoke, inside the service, after local
 * validation; nothing here holds it.
 */
export function createOpenAIDecisionsAgentToolsHandler(params: {
  settings: DecisionSettingsReader;
  recordUsageLines: (lines: ThreadUsageLineRecord[]) => Promise<void>;
  /** Tells the calling thread's windows a batch moved. */
  announceBatch?: OpenAIDecisionsServiceOptions["announceBatch"];
  /** Wakes the calling thread when its background batch ends. */
  wakeThread?: OpenAIDecisionsServiceOptions["wakeThread"];
}): PwrAgentOpenAIDecisionsHandler {
  // Opened on first tool call, so installing the handler never touches the
  // profile database during boot.
  let store: OpenAIDecisionRegistryStorage | undefined;
  const lazyStore = (): OpenAIDecisionRegistryStorage => (store ??= createOpenAIDecisionStorage());
  const service = new OpenAIDecisionsService({
    store: {
      insertFirstVersion: (record) => lazyStore().insertFirstVersion(record),
      insertNextVersion: (record) => lazyStore().insertNextVersion(record),
      softDelete: (decisionId) => lazyStore().softDelete(decisionId),
      getVersion: (decisionId, version) => lazyStore().getVersion(decisionId, version),
      getActive: (decisionId) => lazyStore().getActive(decisionId),
      findActiveByName: (name, caller) => lazyStore().findActiveByName(name, caller),
      listVisible: (caller) => lazyStore().listVisible(caller),
      listActiveProfile: () => lazyStore().listActiveProfile(),
      hasDeletedName: (name, caller) => lazyStore().hasDeletedName(name, caller),
    },
    readApiKey: async () => await params.settings.resolveOpenAIDecisionsApiKey(),
    readAccountSettings: () => {
      const { organizationId, projectId } = params.settings.resolveOpenAIDecisionsSettings();
      return { ...(organizationId ? { organizationId } : {}), ...(projectId ? { projectId } : {}) };
    },
    readSystemOneTarget: async (provider) => await readSystemOneTarget(params.settings, provider),
    readProviderModel: (provider) => {
      const settings = resolveDecisionModelSettings(params.settings.resolveDecisionModelSettings());
      return provider === "local" ? settings.localModel : provider === "jev" ? settings.jevModel : undefined;
    },
    resolveDefaultProvider: async () => await resolveDefaultDecisionProvider(params.settings),
    isProviderEnabled: (provider) => isDecisionProviderEnabled(params.settings, provider),
    profileId: () => resolveActiveProfileName(),
    recordUsageLines: params.recordUsageLines,
    ...(params.announceBatch ? { announceBatch: params.announceBatch } : {}),
    ...(params.wakeThread ? { wakeThread: params.wakeThread } : {}),
    // Each batch's answers as JSONL in its thread's storage, removed with the thread.
    batchResultsDirectory: (caller) => threadDecisionBatchDirectory({
      backend: caller.backend as AppServerBackendKind,
      threadId: caller.threadId,
    }),
    log: {
      info: (message, fields) => openAIDecisionsLog.info(message, fields),
      warn: (message, fields) => openAIDecisionsLog.warn(message, fields),
    },
  });
  flushPendingUsage = async () => await service.close();
  rail = {
    railSnapshot: async (caller) => await service.railSnapshot(caller),
    railActiveBatches: (caller) => service.railActiveBatches(caller),
    railBatchPage: async (caller, params) => await service.railBatchPage(caller, params),
    operatorBatchAction: async (caller, batchId, action) => await service.operatorBatchAction(caller, batchId, action),
    railResultsFile: async (caller, batchId) => await service.railResultsFile(caller, batchId),
    profileDecisions: () => service.profileDecisions(),
    deleteProfileDecision: (decisionId) => service.deleteProfileDecision(decisionId),
  };
  return {
    register: (caller, args) => service.register(caller, args),
    list: (caller, args) => service.list(caller, args),
    invoke: async (caller, args, signal, onProgress) => await service.invoke(caller, args, signal, onProgress),
    update: (caller, args) => service.update(caller, args),
    delete: (caller, args) => service.delete(caller, args),
    batchResults: async (caller, args) => await service.batchResults(caller, args),
    cancelBatch: async (caller, args) => await service.cancelBatch(caller, args),
  };
}
