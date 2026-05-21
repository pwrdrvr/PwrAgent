import type {
  DesktopSettingsSecretName,
  DesktopSettingsSecretStorageState,
} from "@pwragent/shared";
import {
  isSecretStorageDisabledByEnv,
  type DesktopSecretStore,
} from "../settings/desktop-secret-store";
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
    // Dev-only opt-out: lets developers run unsigned Electron dev
    // builds on macOS without triggering the bogus "Keychain Not
    // Found" prompt that OSCrypt generates for un-/ad-hoc-signed
    // binaries. Reports unavailable, so callers route around any
    // safeStorage operation; setSecret no-ops. See
    // SECRET_STORAGE_DISABLED_ENV for the env var name.
    if (isSecretStorageDisabledByEnv()) {
      return {
        available: false,
        backend: "unavailable",
        encrypted: false,
        unavailableReason:
          "Secret storage disabled via PWRAGENT_DEV_DISABLE_SECRET_STORAGE (dev-only).",
      };
    }
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
    try {
      return this.safeStorage.decryptString(ciphertext);
    } catch {
      // Decryption fails when the ciphertext was encrypted under a different
      // signing identity (e.g. dev build vs signed release). Return undefined
      // so callers treat it as "secret not set" and prompt re-entry.
      return undefined;
    }
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
    // Dev-only opt-out: silent no-op when the env var is set.
    // `assertWritable` would otherwise throw "Secret storage
    // disabled via …" which would bubble up as a UI error. The
    // intent of the dev opt-out is to silence the keychain UX,
    // not to surface an alarming "couldn't save" message.
    if (isSecretStorageDisabledByEnv()) {
      return;
    }
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
