import type {
  DesktopSettingsSecretName,
  DesktopSettingsSecretStorageState,
} from "@pwragnt/shared";

export interface DesktopSecretStore {
  describe(): DesktopSettingsSecretStorageState;
  getSecretSync?(name: DesktopSettingsSecretName): string | undefined;
  getSecret(name: DesktopSettingsSecretName): Promise<string | undefined>;
  setSecret(name: DesktopSettingsSecretName, value: string): Promise<void>;
  deleteSecret(name: DesktopSettingsSecretName): Promise<void>;
}

export class MemoryDesktopSecretStore implements DesktopSecretStore {
  private readonly values = new Map<DesktopSettingsSecretName, string>();

  constructor(
    private readonly state: DesktopSettingsSecretStorageState = {
      available: true,
      backend: "memory",
      encrypted: false,
    },
  ) {}

  describe(): DesktopSettingsSecretStorageState {
    return this.state;
  }

  getSecretSync(name: DesktopSettingsSecretName): string | undefined {
    return this.values.get(name);
  }

  async getSecret(name: DesktopSettingsSecretName): Promise<string | undefined> {
    return this.getSecretSync(name);
  }

  async setSecret(name: DesktopSettingsSecretName, value: string): Promise<void> {
    if (!this.state.available) {
      throw new Error(this.state.unavailableReason ?? "Secret storage unavailable");
    }
    this.values.set(name, value);
  }

  async deleteSecret(name: DesktopSettingsSecretName): Promise<void> {
    this.values.delete(name);
  }
}
