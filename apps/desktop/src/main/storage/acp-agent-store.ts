import { AcpAgentStore as SharedAcpAgentStore } from "@pwragent/sqlite-storage/acp-agent-store";
import type { AcpInstalledAgentRecord, AcpRegistrySnapshot } from "../acp/acp-registry-types";

export const AcpAgentStore = SharedAcpAgentStore<AcpRegistrySnapshot, AcpInstalledAgentRecord>;
export type AcpAgentStore = SharedAcpAgentStore<AcpRegistrySnapshot, AcpInstalledAgentRecord>;
