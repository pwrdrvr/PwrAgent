import type { AutomationStorage } from "@pwragent/owner-core/automation-storage";
import { getAppAutomationStore } from "../state/app-state";

// Resolve at the existing application accessor boundary, so profile changes
// and application store initialization retain their current ownership.
export function getAutomationStorage(): AutomationStorage {
  return getAppAutomationStore();
}
