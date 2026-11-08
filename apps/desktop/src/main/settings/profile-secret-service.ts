import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { WriteDesktopSecretsToProfileRequest, WriteDesktopSecretsToProfileResponse } from "@pwragent/shared";
import { normalizeProfileName, resolveProfileDir } from "../profile";
import { openProfileSecretStorage } from "../storage/desktop-settings-storage";
import { isSecretStorageDisabledByEnv } from "./desktop-secret-store";
import { getMainLogger } from "../log";

const profilesIpcLog = getMainLogger("pwragent:profiles");

/**
 * Write secrets directly to a specific PwrAgent profile's keychain
 * (its state.db `secrets` table), encrypting each value via
 * `safeStorage` first. Used by the wizard's Finish path to graduate
 * in-memory messaging credentials collected during the wizard to the
 * operator's chosen real profile, avoiding stranded secrets in
 * `.bootstrap/state.db` when the
 * wizard runs in bootstrap mode.
 *
 * Implementation notes:
 *   - Opens the target profile's state.db transiently (not via the
 *     singleton) so this can run in any app-state mode, including
 *     bootstrap mode where the singleton is bound to `.bootstrap/`.
 *   - Closes the transient DB even on error to avoid leaking
 *     better-sqlite3 handles.
 *   - Empty string values delete the secret (clears stale entries).
 *   - Unencrypted-storage edge cases (basic_text / unavailable) are
 *     surfaced as a thrown error rather than silently writing
 *     plaintext — caller decides whether to retry or warn.
 */
export function writeDesktopSecretsToProfile(
  request: WriteDesktopSecretsToProfileRequest,
): WriteDesktopSecretsToProfileResponse {
  const profile = normalizeProfileName(request.profile);
  if (!profile) {
    throw new Error(
      `Profile name "${request.profile}" must contain at least one letter or number.`,
    );
  }
  // Dev-only opt-out: skip the entire write path when the env var
  // is set. Returns success with an empty `written` list so the
  // caller (wizard) treats it as "secrets handled" and moves on.
  // The operator's typed values are silently dropped — they'll
  // need to re-enter them in Settings → Models post-graduation.
  // Acceptable in dev; production builds shouldn't set this.
  if (isSecretStorageDisabledByEnv()) {
    // WARN, not info — typed secrets are silently dropped here, and
    // the operator should be made aware (via app log or support
    // bundle) that their key paste didn't actually land in the
    // keychain. Production builds wouldn't get here at all because
    // `rejectDevOnlyEnvVarsInProduction()` in index.ts clears the
    // env var on packaged launches.
    profilesIpcLog.warn(
      "writeDesktopSecretsToProfile SKIPPED — secret storage disabled by env (typed values dropped)",
      { profile },
    );
    return { profile, written: [] };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secret storage encryption is unavailable.");
  }

  const profileDir = resolveProfileDir(profile);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Profile "${profile}" does not exist.`);
  }

  const dbPath = path.join(profileDir, "state", "state.db");
  // Ensure the state dir exists. For a freshly-created paired profile
  // the wizard just called ensureNamedProfileExists which seeded
  // `<profile>/state/`, so this is normally a no-op — but graduating
  // to an existing profile that's never been opened (rare, but
  // possible via Settings → Profiles "Create") needs it.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const storage = openProfileSecretStorage(dbPath, { profileName: profile });
  const written: string[] = [];
  try {
    for (const [name, value] of Object.entries(request.secrets)) {
      if (typeof name !== "string" || name.length === 0) continue;
      if (typeof value !== "string") continue;
      if (value.length === 0) {
        storage.deleteSecret(name);
        written.push(name);
        continue;
      }
      const ciphertext = safeStorage.encryptString(value);
      storage.setSecret(name, ciphertext);
      written.push(name);
    }
  } finally {
    storage.close();
  }

  return { profile, written };
}

