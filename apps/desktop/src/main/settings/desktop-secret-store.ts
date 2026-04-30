import fs from "node:fs";
import path from "node:path";
import type {
  DesktopSettingsSecretName,
  DesktopSettingsSecretStorageState,
} from "@pwragnt/shared";
import { resolveDesktopStateRoot } from "../app-server/desktop-state-root";

type SafeStorageLike = {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?: () => string;
};

type SecretRecord = {
  ciphertext: string;
};

type SecretFile = Partial<Record<DesktopSettingsSecretName, SecretRecord>>;

export interface DesktopSecretStore {
  describe(): DesktopSettingsSecretStorageState;
  getSecretSync?(name: DesktopSettingsSecretName): string | undefined;
  getSecret(name: DesktopSettingsSecretName): Promise<string | undefined>;
  setSecret(name: DesktopSettingsSecretName, value: string): Promise<void>;
  deleteSecret(name: DesktopSettingsSecretName): Promise<void>;
}

export class FileBackedSafeStorageSecretStore implements DesktopSecretStore {
  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly filePath = path.join(
      resolveDesktopStateRoot(),
      "settings-secrets.json",
    ),
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
    const record = this.readRecords()[name];
    if (!record?.ciphertext) {
      return undefined;
    }

    return this.safeStorage.decryptString(
      Buffer.from(record.ciphertext, "base64"),
    );
  }

  async getSecret(name: DesktopSettingsSecretName): Promise<string | undefined> {
    return this.getSecretSync(name);
  }

  async setSecret(name: DesktopSettingsSecretName, value: string): Promise<void> {
    this.assertWritable();
    const records = this.readRecords();
    records[name] = {
      ciphertext: this.safeStorage.encryptString(value).toString("base64"),
    };
    this.writeRecords(records);
  }

  async deleteSecret(name: DesktopSettingsSecretName): Promise<void> {
    const records = this.readRecords();
    delete records[name];
    this.writeRecords(records);
  }

  private assertWritable(): void {
    const state = this.describe();
    if (!state.available) {
      throw new Error(state.unavailableReason ?? "Secret storage unavailable");
    }
  }

  private readRecords(): SecretFile {
    if (!fs.existsSync(this.filePath)) {
      return {};
    }

    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SecretFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  }

  private writeRecords(records: SecretFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(records, null, 2), "utf8");
    fs.renameSync(temporaryPath, this.filePath);
  }
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
