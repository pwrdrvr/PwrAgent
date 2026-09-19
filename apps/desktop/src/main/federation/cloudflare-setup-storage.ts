import { safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CloudflareSetupDraft } from "@pwragent/shared";
import { resolveDesktopConfigPath } from "../settings/desktop-config";
import { isSecretStorageDisabledByEnv } from "../settings/desktop-secret-store";
import type { CloudflareAccessSession } from "./cloudflare-access-oauth";
import type { CloudflareSetupState } from "./cloudflare-setup-service";

function stateFile(name: string) {
  return path.join(path.dirname(resolveDesktopConfigPath()), "state", name);
}

const SETUP_FILE = "cloudflare-federation.enc";
const SESSION_FILE = "cloudflare-access-session.enc";
const DRAFT_FILE = "cloudflare-federation-draft.json";

function requireSecureStorage() {
  if (!safeStorage.isEncryptionAvailable()
    || (process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text")
    || isSecretStorageDisabledByEnv()) {
    throw new Error("Secure storage is unavailable. Use a signed PwrAgent build with OS credential storage enabled.");
  }
}

async function readOptional(name: string): Promise<Buffer | undefined> {
  try { return await fs.readFile(stateFile(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Write-then-rename, so a crash never leaves a truncated file in place. */
async function writeAtomic(name: string, data: Buffer | string): Promise<void> {
  const destination = stateFile(name);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function loadCloudflareSetup(): Promise<CloudflareSetupState | undefined> {
  const data = await readOptional(SETUP_FILE);
  if (!data) return undefined;
  requireSecureStorage();
  try {
    const state = JSON.parse(safeStorage.decryptString(data)) as CloudflareSetupState;
    // A service-token setup has no certificate authority, so the validator —
    // which every gate has — is what proves the record is complete.
    if (state.version !== 1 || !state.verifier || !Array.isArray(state.clients)) throw new Error();
    return state;
  } catch { throw new Error("The Cloudflare setup could not be decrypted. Its encrypted data has been preserved."); }
}

export async function saveCloudflareSetup(state: CloudflareSetupState): Promise<void> {
  requireSecureStorage();
  await writeAtomic(SETUP_FILE, safeStorage.encryptString(JSON.stringify(state)));
}

/** Forget the gateway setup record. Callers delete what it names in Cloudflare first. */
export async function clearCloudflareSetup(): Promise<void> {
  await fs.rm(stateFile(SETUP_FILE), { force: true });
}

/**
 * This instance's own Cloudflare Access sign-in. It holds a refresh token, so
 * it is encrypted like the gateway setup; unlike it, a record that no longer
 * decrypts is simply a signed-out state — signing in again recreates it.
 */
export async function loadCloudflareAccessSession(): Promise<CloudflareAccessSession | undefined> {
  const data = await readOptional(SESSION_FILE);
  if (!data) return undefined;
  requireSecureStorage();
  try {
    const session = JSON.parse(safeStorage.decryptString(data)) as CloudflareAccessSession;
    return session.version === 1 && typeof session.endpoint === "string" ? session : undefined;
  } catch { return undefined; }
}

export async function saveCloudflareAccessSession(session: CloudflareAccessSession | undefined): Promise<void> {
  if (!session) {
    await fs.rm(stateFile(SESSION_FILE), { force: true });
    return;
  }
  requireSecureStorage();
  await writeAtomic(SESSION_FILE, safeStorage.encryptString(JSON.stringify(session)));
}

/**
 * The half-finished form. Account and zone IDs, a hostname, and an email list
 * are not secrets, and the API token is never part of a draft, so this is plain
 * JSON: saving a draft must work even where secure storage does not.
 */
export async function loadCloudflareSetupDraft(): Promise<CloudflareSetupDraft | undefined> {
  const data = await readOptional(DRAFT_FILE);
  if (!data) return undefined;
  try { return sanitizeCloudflareDraft(JSON.parse(data.toString("utf8"))); }
  catch { return undefined; }
}

export async function saveCloudflareSetupDraft(draft: CloudflareSetupDraft): Promise<CloudflareSetupDraft> {
  const clean = sanitizeCloudflareDraft(draft);
  await writeAtomic(DRAFT_FILE, JSON.stringify(clean));
  return clean;
}

/**
 * Keeps a draft to the shape and size of what the form can hold. It checks
 * type and length only — a draft is allowed to be wrong; `connect` and
 * `provision` are where values are validated.
 */
export function sanitizeCloudflareDraft(value: unknown): CloudflareSetupDraft {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const text = (entry: unknown, max: number) =>
    typeof entry === "string" && entry.trim() ? entry.trim().slice(0, max) : undefined;
  const gate = input.gate === "service-token" || input.gate === "oauth" || input.gate === "mtls" ? input.gate : undefined;
  const emails = Array.isArray(input.emails)
    ? input.emails.map((entry) => text(entry, 254)).filter((entry): entry is string => Boolean(entry)).slice(0, 50)
    : undefined;
  return {
    accountId: text(input.accountId, 64),
    zoneId: text(input.zoneId, 64),
    hostname: text(input.hostname, 253),
    gate,
    emails: emails?.length ? emails : undefined,
  };
}
