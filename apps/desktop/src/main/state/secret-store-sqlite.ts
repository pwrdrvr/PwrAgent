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

const KEYCHAIN_ACCESS_ERROR =
  "PwrAgent could not unlock secret storage. Choose Allow in the macOS Keychain prompt to read or save secrets.";

export class DbBackedSafeStorageSecretStore implements DesktopSecretStore {
  private readonly secretAccessErrors = new Map<
    DesktopSettingsSecretName,
    string
  >();

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

  getSecretAccessError(name: DesktopSettingsSecretName): string | undefined {
    return this.secretAccessErrors.get(name);
  }

  async hasSecret(name: DesktopSettingsSecretName): Promise<boolean> {
    if (this.secretAccessErrors.has(name)) {
      return false;
    }
    return Boolean(this.stateDb.getSecret(name));
  }

  getSecretSync(name: DesktopSettingsSecretName): string | undefined {
    const ciphertext = this.stateDb.getSecret(name);
    if (!ciphertext) {
      this.secretAccessErrors.delete(name);
      return undefined;
    }
    try {
      const value = this.safeStorage.decryptString(ciphertext);
      this.secretAccessErrors.delete(name);
      return value;
    } catch {
      // Decryption fails when the ciphertext was encrypted under a different
      // signing identity (e.g. dev build vs signed release). Return undefined
      // so callers treat it as "secret not set" and prompt re-entry.
      this.secretAccessErrors.set(name, KEYCHAIN_ACCESS_ERROR);
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
    let ciphertext: Buffer;
    try {
      ciphertext = this.safeStorage.encryptString(value);
    } catch (error) {
      this.secretAccessErrors.set(name, KEYCHAIN_ACCESS_ERROR);
      throw new Error(KEYCHAIN_ACCESS_ERROR, { cause: error });
    }
    this.stateDb.setSecret(name, ciphertext);
    this.secretAccessErrors.delete(name);
  }

  async deleteSecret(name: DesktopSettingsSecretName): Promise<void> {
    this.stateDb.deleteSecret(name);
    this.secretAccessErrors.delete(name);
  }

  private assertWritable(): void {
    const state = this.describe();
    if (!state.available) {
      throw new Error(state.unavailableReason ?? "Secret storage unavailable");
    }
  }
}
