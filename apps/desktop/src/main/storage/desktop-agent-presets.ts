import type { AgentPreset, ManageAgentPresetsRequest } from "@pwragent/shared/contracts/agent-presets";
import { deleteAgentPreset, listAgentPresets, saveAgentPreset } from "@pwragent/sqlite-storage/agent-preset-store";
import { getAppStateDb } from "../state/app-state";

export function manageDesktopAgentPresets(request: ManageAgentPresetsRequest): AgentPreset[] {
  const stateDb = getAppStateDb();
  switch (request?.action) {
    case "list":
      break;
    case "save":
      saveAgentPreset(stateDb, request.preset);
      break;
    case "delete":
      deleteAgentPreset(stateDb, request.id);
      break;
    default:
      throw new Error("Unknown Agent preset action.");
  }
  return listAgentPresets(stateDb);
}
