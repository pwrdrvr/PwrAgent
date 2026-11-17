import type { ThreadUsageLineRecord } from "@pwragent/shared";
import {
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
  settings: DecisionSettingsReader & {
    resolveOpenAIDecisionsSettings: () => { organizationId?: string; projectId?: string };
  };
  recordUsageLines: (lines: ThreadUsageLineRecord[]) => Promise<void>;
  /** Shows a batch's progress as a card on its calling thread. */
  reportBatch?: OpenAIDecisionsServiceOptions["reportBatch"];
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
      hasDeletedName: (name, caller) => lazyStore().hasDeletedName(name, caller),
    },
    readApiKey: async () => await params.settings.resolveOpenAIDecisionsApiKey(),
    readAccountSettings: () => params.settings.resolveOpenAIDecisionsSettings(),
    readSystemOneTarget: async (provider) => await readSystemOneTarget(params.settings, provider),
    resolveDefaultProvider: async () => await resolveDefaultDecisionProvider(params.settings),
    profileId: () => resolveActiveProfileName(),
    recordUsageLines: params.recordUsageLines,
    ...(params.reportBatch ? { reportBatch: params.reportBatch } : {}),
    ...(params.wakeThread ? { wakeThread: params.wakeThread } : {}),
    log: {
      info: (message, fields) => openAIDecisionsLog.info(message, fields),
      warn: (message, fields) => openAIDecisionsLog.warn(message, fields),
    },
  });
  flushPendingUsage = async () => await service.close();
  return {
    register: (caller, args) => service.register(caller, args),
    list: (caller, args) => service.list(caller, args),
    invoke: async (caller, args, signal, onProgress) => await service.invoke(caller, args, signal, onProgress),
    update: (caller, args) => service.update(caller, args),
    delete: (caller, args) => service.delete(caller, args),
    batchResults: (caller, args) => service.batchResults(caller, args),
    cancelBatch: async (caller, args) => await service.cancelBatch(caller, args),
  };
}
