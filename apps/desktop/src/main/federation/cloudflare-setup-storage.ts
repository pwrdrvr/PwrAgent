import { safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveDesktopConfigPath } from "../settings/desktop-config";
import { isSecretStorageDisabledByEnv } from "../settings/desktop-secret-store";
import type { CloudflareSetupState } from "./cloudflare-setup-service";

function filePath() {
  return path.join(path.dirname(resolveDesktopConfigPath()), "state", "cloudflare-federation.enc");
}

function requireSecureStorage() {
  if (!safeStorage.isEncryptionAvailable()
    || (process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text")
    || isSecretStorageDisabledByEnv()) {
    throw new Error("Secure storage is unavailable. Use a signed PwrAgent build with OS credential storage enabled.");
  }
}

export async function loadCloudflareSetup(): Promise<CloudflareSetupState | undefined> {
  let data: Buffer;
  try { data = await fs.readFile(filePath()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  requireSecureStorage();
  try {
    const state = JSON.parse(safeStorage.decryptString(data)) as CloudflareSetupState;
    if (state.version !== 1 || !state.ca || !Array.isArray(state.clients)) throw new Error();
    return state;
  } catch { throw new Error("The Cloudflare setup could not be decrypted. Its encrypted data has been preserved."); }
}

export async function saveCloudflareSetup(state: CloudflareSetupState): Promise<void> {
  requireSecureStorage();
  const destination = filePath();
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(safeStorage.encryptString(JSON.stringify(state)));
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}
