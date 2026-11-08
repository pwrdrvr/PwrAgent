import type { DesktopConfigSnapshotStorage } from "../settings/config-store/durable-config-snapshot";
import { getAppStateDb } from "../state/app-state";
import { DurableConfigSnapshotStore } from "./durable-config-snapshot-store";

export function createDesktopConfigSnapshotStorage(): DesktopConfigSnapshotStorage {
  return new DurableConfigSnapshotStore(getAppStateDb());
}
