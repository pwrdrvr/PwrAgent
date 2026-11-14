import type { ThreadUsageLineRecord } from "@pwragent/shared";
import type { PwrAgentOpenAIDecisionsHandler } from "../agent-tools/pwragent-openai-decisions-agent-tools";
import { getMainLogger } from "../log";
import { resolveActiveProfileName } from "../profile";
import type { OpenAIDecisionRegistryStorage } from "../storage/openai-decision-store";
import { createOpenAIDecisionStorage } from "../storage/desktop-runtime-storage";
import { OpenAIDecisionsService } from "./openai-decisions-service";

const openAIDecisionsLog = getMainLogger("pwragent:openai-decisions");

/**
 * Builds the decisions tool handler for this owner. The key is read from the
 * settings secret store on each invoke, inside the service, after local
 * validation; nothing here holds it.
 */
export function createOpenAIDecisionsAgentToolsHandler(params: {
  settings: {
    resolveOpenAIDecisionsApiKey: () => Promise<string | undefined>;
    resolveOpenAIDecisionsSettings: () => { organizationId?: string; projectId?: string };
  };
  recordUsageLine: (line: ThreadUsageLineRecord) => Promise<void>;
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
    profileId: () => resolveActiveProfileName(),
    recordUsageLine: params.recordUsageLine,
    log: {
      info: (message, fields) => openAIDecisionsLog.info(message, fields),
      warn: (message, fields) => openAIDecisionsLog.warn(message, fields),
    },
  });
  return {
    register: (caller, args) => service.register(caller, args),
    list: (caller, args) => service.list(caller, args),
    invoke: async (caller, args, signal) => await service.invoke(caller, args, signal),
    update: (caller, args) => service.update(caller, args),
    delete: (caller, args) => service.delete(caller, args),
  };
}
