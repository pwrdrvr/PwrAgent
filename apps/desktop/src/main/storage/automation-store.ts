import { AutomationStore as SharedAutomationStore } from "@pwragent/sqlite-storage/automation-store";
import type { AutomationStoreOptions } from "@pwragent/sqlite-storage/automation-store";
import { getMainLogger } from "../log.js";
import type { StateDb } from "./state-db.js";

export type {
  AutomationRecord,
  CreateAutomationInput,
  UpdateAutomationInput,
  CreateAutomationRunInput,
  StartupReconciliationInput,
  UpsertAutomationRunArtifactInput,
} from "@pwragent/owner-core/automation-storage";

const automationStoreLog = getMainLogger("pwragent:automations");

// Keep host diagnostics and the existing app-state construction boundary here.
export class AutomationStore extends SharedAutomationStore {
  constructor(stateDb: StateDb, options: Pick<AutomationStoreOptions, "runHistoryLimit"> = {}) {
    super(stateDb, {
      ...options,
      warn: (message, details) => automationStoreLog.warn(message, details),
    });
  }
}
