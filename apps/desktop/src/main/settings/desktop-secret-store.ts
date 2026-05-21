import type {
  DesktopSettingsSecretName,
  DesktopSettingsSecretStorageState,
} from "@pwragent/shared";

/**
 * Opt-out env var for keychain access. When set to `"1"`, `"true"`,
 * or `"yes"`, the secret store reports as unavailable and all
 * setSecret/encrypt operations are silent no-ops. Intended for
 * unsigned dev Electron builds on macOS where `safeStorage.encryptString`
 * triggers a confusing "Keychain Not Found" dialog because the
 * Electron binary lacks a stable code-signed identity — the signed
 * release build doesn't have this problem. Set this in the dev
 * shell once and the wizard won't prompt anymore.
 *
 * **Dev-only.** `rejectDevOnlyEnvVarsInProduction()` in `index.ts`
 * clears this env var on packaged builds (`app.isPackaged ===
 * true`) before any consumer reads it, so a production operator
 * who copy-pastes a Stack-Overflow tip into their shell rc can't
 * silently disable their own keychain.
 */
export const SECRET_STORAGE_DISABLED_ENV =
  "PWRAGENT_DEV_DISABLE_SECRET_STORAGE";

export function isSecretStorageDisabledByEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[SECRET_STORAGE_DISABLED_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

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
