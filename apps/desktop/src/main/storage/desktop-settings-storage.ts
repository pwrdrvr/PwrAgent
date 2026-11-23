import type { DesktopConfigSnapshotStorage } from "../settings/config-store/durable-config-snapshot";
import type { ProfileSecretStorage, SettingsSecretEncryption, SettingsSecretStorage } from "@pwragent/owner-core/settings-secret-storage";
import { getAppStateDb, getAppStateMode } from "../state/app-state";
import { DbBackedSafeStorageSecretStore } from "../state/secret-store-sqlite";
import { StateDb } from "./state-db";
import { DurableConfigSnapshotStore } from "./durable-config-snapshot-store";

export { getAppStateMode };

export function reserveTelegramConnectionId(attempt: string, proposedId: string): string {
  return getAppStateDb().getOrInsertMeta(`telegram_connection_migration_v1:${attempt}`, proposedId);
}

export function releaseTelegramConnectionId(attempt: string, id: string): void {
  getAppStateDb().deleteMetaIfValue(`telegram_connection_migration_v1:${attempt}`, id);
}

export function createDesktopConfigSnapshotStorage(): DesktopConfigSnapshotStorage {
  return new DurableConfigSnapshotStore(getAppStateDb());
}

export function createDesktopSecretStorage(
  safeStorage: SettingsSecretEncryption<Buffer>,
): SettingsSecretStorage {
  return new DbBackedSafeStorageSecretStore(safeStorage, getAppStateDb());
}

export function openProfileSecretStorage(
  dbPath: string,
  options: { profileName: string },
): ProfileSecretStorage<Buffer> {
  const stateDb = StateDb.open(dbPath, options);
  return {
    setSecret: (name, ciphertext) => stateDb.setSecret(name, ciphertext),
    deleteSecret: (name) => stateDb.deleteSecret(name),
    close: () => stateDb.close(),
  };
}
