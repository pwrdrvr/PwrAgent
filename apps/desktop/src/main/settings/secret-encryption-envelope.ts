import type { SettingsSecretEncryption } from "@pwragent/owner-core/settings-secret-storage";

export type SecretEncryptor = "desktop-safe-storage" | "headless-file-key";
const prefix = Buffer.from("PWRAGENT-SECRET/1\0");

export class SecretCiphertextError extends Error {
  constructor(readonly kind: "wrong-host" | "corrupt", message: string) {
    super(message);
  }
}

function readEnvelope(value: Buffer): { encryptor: SecretEncryptor; payload: Buffer } {
  // Existing untagged profile secrets were written by Electron safeStorage.
  if (!value.subarray(0, prefix.length).equals(prefix)) return { encryptor: "desktop-safe-storage", payload: value };
  const end = value.indexOf(0, prefix.length);
  const encryptor = value.subarray(prefix.length, end).toString("utf8");
  if (end < 0 || (encryptor !== "desktop-safe-storage" && encryptor !== "headless-file-key") || end === value.length - 1) {
    throw new SecretCiphertextError("corrupt", "The stored secret has a damaged encryption envelope. Its ciphertext has been preserved.");
  }
  return { encryptor, payload: value.subarray(end + 1) };
}

/** Preserve the host's cipher; the envelope identifies which host can read it. */
export function tagSecretEncryption(encryption: SettingsSecretEncryption<Buffer>, encryptor: SecretEncryptor): SettingsSecretEncryption<Buffer> {
  const read = (value: Buffer): Buffer => {
    const envelope = readEnvelope(value);
    if (envelope.encryptor !== encryptor) {
      const writer = envelope.encryptor === "desktop-safe-storage" ? "the desktop OS keychain" : "the headless host's file key";
      throw new SecretCiphertextError("wrong-host", `This secret was encrypted by ${writer} and is unavailable in this host. Its ciphertext has been preserved; re-enter the secret to replace it.`);
    }
    return envelope.payload;
  };
  return {
    isEncryptionAvailable: () => encryption.isEncryptionAvailable(),
    getSelectedStorageBackend: () => encryption.getSelectedStorageBackend?.() ?? "unavailable",
    encryptString: (value) => Buffer.concat([prefix, Buffer.from(`${encryptor}\0`), encryption.encryptString(value)]),
    decryptString: (value) => encryption.decryptString(read(value)),
    getCiphertextAccessError: (value) => {
      try { read(value); return undefined; }
      catch (error) { return error instanceof SecretCiphertextError ? error.message : "The stored secret's encryption envelope could not be read."; }
    },
  };
}
