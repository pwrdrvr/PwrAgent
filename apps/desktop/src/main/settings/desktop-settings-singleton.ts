import { safeStorage } from "electron";
import { DesktopSettingsService } from "./desktop-settings-service";
import { FileBackedSafeStorageSecretStore } from "./desktop-secret-store";

let desktopSettingsService: DesktopSettingsService | undefined;

export function getDesktopSettingsService(): DesktopSettingsService {
  desktopSettingsService ??= new DesktopSettingsService({
    secretStore: new FileBackedSafeStorageSecretStore(safeStorage),
  });
  return desktopSettingsService;
}

export function resetDesktopSettingsServiceForTests(): void {
  desktopSettingsService = undefined;
}
