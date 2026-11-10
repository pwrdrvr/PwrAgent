import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { SettingsSecretEncryption } from "@pwragent/owner-core/settings-secret-storage";
import { SecretCiphertextError, tagSecretEncryption } from "../settings/secret-encryption-envelope";

const associatedData = Buffer.from("PwrAgent headless secrets v1");
export const HEADLESS_SECRET_KEY_FILENAME = "headless-secret.key";

function readPrivateKey(file: string): Buffer {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) || stat.size !== 32) {
      throw new Error("The headless secret key must be a 32-byte regular file with mode 0600. The existing file was preserved.");
    }
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function loadOrCreateKey(stateDirectory: string): Buffer {
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDirectory, 0o700);
  const destination = path.join(stateDirectory, HEADLESS_SECRET_KEY_FILENAME);
  try { return readPrivateKey(destination); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = path.join(stateDirectory, `.headless-secret-${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    try { fs.writeFileSync(descriptor, randomBytes(32)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    // Publish only a complete key, without replacing another process's key.
    try { fs.linkSync(temporary, destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return readPrivateKey(destination);
  } finally {
    fs.rmSync(temporary, { force: true });
    if (process.platform !== "win32") {
      const directory = fs.openSync(stateDirectory, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  }
}

/** Only the Node host calls this. Desktop continues to use OS safeStorage. */
export function createFileKeyEncryption(stateDirectory: string): SettingsSecretEncryption<Buffer> {
  const key = loadOrCreateKey(stateDirectory);
  return tagSecretEncryption({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "file-key",
    encryptString(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(associatedData);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      try {
        if (value.length < 29 || value[0] !== 1) throw new Error("Invalid file-key ciphertext");
        const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(1, 13));
        decipher.setAAD(associatedData);
        decipher.setAuthTag(value.subarray(13, 29));
        return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretCiphertextError("corrupt", "The stored headless secret is damaged or its file key does not match. Its ciphertext has been preserved.");
      }
    },
  }, "headless-file-key");
}
