import type { DesktopSettingsSecretName, DesktopSettingsSecretStorageState } from "@pwragent/shared";

/** Encryption is supplied by the host operating system. */
export interface SettingsSecretEncryption<Ciphertext> {
  encryptString(value: string): Ciphertext;
  decryptString(value: Ciphertext): string;
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?: () => string;
}

/** Host-encrypted secrets; callers receive values and availability, never a database. */
export interface SettingsSecretStorage {
  describe(): DesktopSettingsSecretStorageState;
  getSecretAccessError?(name: DesktopSettingsSecretName): string | undefined;
  hasSecret(name: DesktopSettingsSecretName): Promise<boolean>;
  getSecretSync?(name: DesktopSettingsSecretName): string | undefined;
  getSecret(name: DesktopSettingsSecretName): Promise<string | undefined>;
  setSecret(name: DesktopSettingsSecretName, value: string): Promise<void>;
  deleteSecret(name: DesktopSettingsSecretName): Promise<void>;
}

/** A transient target-profile writer. Its application caller owns the lifetime. */
export interface ProfileSecretStorage<Ciphertext> {
  setSecret(name: string, ciphertext: Ciphertext): void;
  deleteSecret(name: string): void;
  close(): void;
}
