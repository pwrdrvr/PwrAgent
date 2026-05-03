import type {
  DesktopSettingsSecretName,
  DesktopSettingsSecretStorageState,
} from "@pwragnt/shared";
import type { DesktopSecretStore } from "../settings/desktop-secret-store";
import type { StateDb } from "./state-db.js";

type SafeStorageLike = {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?: () => string;
};

export class DbBackedSafeStorageSecretStore implements DesktopSecretStore {
  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly stateDb: StateDb,
  ) {}

  describe(): DesktopSettingsSecretStorageState {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return {
        available: false,
        backend: "unavailable",
        encrypted: false,
        unavailableReason: "Secret storage encryption is unavailable.",
      };
    }

    const selectedBackend = this.safeStorage.getSelectedStorageBackend?.();
    if (selectedBackend === "basic_text") {
      return {
        available: false,
        backend: "safeStorage",
        encrypted: false,
        unavailableReason:
          "Secret storage is using the unsafe basic_text backend.",
      };
    }

    return {
      available: true,
      backend: "safeStorage",
      encrypted: true,
    };
  }

  getSecretSync(name: DesktopSettingsSecretName): string | undefined {
    const ciphertext = this.stateDb.getSecret(name);
    if (!ciphertext) return undefined;
    return this.safeStorage.decryptString(ciphertext);
  }

  async getSecret(
    name: DesktopSettingsSecretName,
  ): Promise<string | undefined> {
    return this.getSecretSync(name);
  }

  async setSecret(
    name: DesktopSettingsSecretName,
    value: string,
  ): Promise<void> {
    this.assertWritable();
    const ciphertext = this.safeStorage.encryptString(value);
    this.stateDb.setSecret(name, ciphertext);
  }

  async deleteSecret(name: DesktopSettingsSecretName): Promise<void> {
    this.stateDb.deleteSecret(name);
  }

  private assertWritable(): void {
    const state = this.describe();
    if (!state.available) {
      throw new Error(state.unavailableReason ?? "Secret storage unavailable");
    }
  }
}
