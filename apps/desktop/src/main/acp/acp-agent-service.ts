import type { AcpBackendId } from "@pwragent/shared";
import { getAppStateDb } from "../state/app-state";
import { AcpAgentStore } from "../storage/acp-agent-store";
import type { AcpInstalledAgentRecord, AcpRegistrySnapshot } from "./acp-registry-types";

/** Installed-agent state and registry cache for desktop settings. */
export class AcpAgentService {
  private readonly store = new AcpAgentStore(getAppStateDb());

  saveRegistrySnapshot(snapshot: AcpRegistrySnapshot): void {
    this.store.saveRegistrySnapshot(snapshot);
  }

  readRegistrySnapshot(): AcpRegistrySnapshot | undefined {
    return this.store.readRegistrySnapshot();
  }

  listInstalledAgents(): AcpInstalledAgentRecord[] {
    return this.store.listInstalledAgents();
  }

  getInstalledAgent(backendId: AcpBackendId): AcpInstalledAgentRecord | undefined {
    return this.store.getInstalledAgent(backendId);
  }

  upsertInstalledAgent(record: AcpInstalledAgentRecord): void {
    this.store.upsertInstalledAgent(record);
  }
}
