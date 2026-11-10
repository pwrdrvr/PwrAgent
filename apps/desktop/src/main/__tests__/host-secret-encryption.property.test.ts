import { DesktopSettingsService } from "../settings/desktop-settings-service";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, expect, it, vi } from "vitest";
import type { DesktopSettingsSecretName } from "@pwragent/shared";
import { createFileKeyEncryption, HEADLESS_SECRET_KEY_FILENAME } from "../headless/file-key-encryption";
import { SecretCiphertextError, tagSecretEncryption } from "../settings/secret-encryption-envelope";
import { DbBackedSafeStorageSecretStore } from "../state/secret-store-sqlite";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-encryption-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const osEncryption = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "keychain",
  encryptString: (value: string) => Buffer.from(`OS:${value}`, "utf8"),
  decryptString: vi.fn((value: Buffer) => {
    if (!value.toString("utf8").startsWith("OS:")) throw new Error("OS ciphertext mismatch");
    return value.toString("utf8").slice(3);
  }),
};
const desktop = tagSecretEncryption(osEncryption, "desktop-safe-storage");
const headless = createFileKeyEncryption(path.join(root, "state"));

it.each([
  { name: "desktop to headless", writer: desktop, reader: headless, reason: "desktop OS keychain" },
  { name: "headless to desktop", writer: headless, reader: desktop, reason: "headless host's file key" },
])("$name marks foreign secrets unavailable and preserves them until explicit replacement", async ({ writer, reader, reason }) => {
  await fc.assert(fc.asyncProperty(fc.string(), fc.constantFrom<DesktopSettingsSecretName>("federationInstancePrivateKey", "federationNoiseStaticPrivateKey", "pwrsnapMcpCredential"), async (value, name) => {
    let stored: Buffer | undefined;
    const database = {
      getSecret: () => stored,
      setSecret: vi.fn((_name: string, next: Buffer) => { stored = next; }),
      deleteSecret: vi.fn(),
    };
    const source = new DbBackedSafeStorageSecretStore(writer, database as never);
    const destination = new DbBackedSafeStorageSecretStore(reader, database as never);
    await source.setSecret(name, value);
    const before = Buffer.from(stored!);
    expect(await destination.hasSecret(name)).toBe(false);
    expect(destination.getSecretAccessError(name)).toContain(reason);
    expect(await destination.getSecret(name)).toBeUndefined();
    if (name === "federationInstancePrivateKey" || name === "federationNoiseStaticPrivateKey") {
      const service: DesktopSettingsService = Object.assign(Object.create(DesktopSettingsService.prototype), { options: { secretStore: destination } });
      expect(await service.readFederationKeyAccessErrors()).toContainEqual({ name, reason: destination.getSecretAccessError(name) });
      const key = name === "federationInstancePrivateKey"
        ? service.getOrCreateFederationIdentityKeyPair()
        : service.getOrCreateFederationNoiseStaticKeyPair();
      await expect(key).rejects.toThrow(reason);
    }
    expect(stored).toEqual(before);
    expect(database.setSecret).toHaveBeenCalledTimes(1);
    expect(database.deleteSecret).not.toHaveBeenCalled();
    await destination.setSecret(name, "operator replacement");
    expect(await destination.getSecret(name)).toBe("operator replacement");
    expect(destination.getSecretAccessError(name)).toBeUndefined();
    expect(await destination.hasSecret(name)).toBe(true);
  }));
});

it("authenticates generated payloads and preserves one private key across host restarts", () => {
  const reopened = createFileKeyEncryption(path.join(root, "state"));
  fc.assert(fc.property(fc.string(), (value) => {
    const ciphertext = headless.encryptString(value);
    expect(reopened.decryptString(ciphertext)).toBe(value);
    expect(headless.encryptString(value)).not.toEqual(ciphertext);
    const corrupted = Buffer.from(ciphertext);
    corrupted[corrupted.length - 1] ^= 1;
    expect(() => reopened.decryptString(corrupted)).toThrow(SecretCiphertextError);
    expect(corrupted).not.toEqual(ciphertext);
  }));
  const key = path.join(root, "state", HEADLESS_SECRET_KEY_FILENAME);
  expect(fs.statSync(key).size).toBe(32);
  if (process.platform !== "win32") {
    expect(fs.statSync(key).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(key)).mode & 0o777).toBe(0o700);
  }
});

it("retains legacy desktop secrets and refuses them on headless without invoking OS decryption", () => {
  const legacy = osEncryption.encryptString("legacy");
  expect(desktop.decryptString(legacy)).toBe("legacy");
  osEncryption.decryptString.mockClear();
  expect(() => headless.decryptString(legacy)).toThrow(/desktop OS keychain/);
  expect(osEncryption.decryptString).not.toHaveBeenCalled();
});

it("never replaces a damaged existing file key", () => {
  const state = path.join(root, "damaged-state");
  fs.mkdirSync(state);
  const key = path.join(state, HEADLESS_SECRET_KEY_FILENAME);
  fs.writeFileSync(key, "damaged", { mode: 0o600 });
  expect(() => createFileKeyEncryption(state)).toThrow(/32-byte/);
  expect(fs.readFileSync(key, "utf8")).toBe("damaged");
});

it("publishes only complete keys and preserves a competing creator's winner", () => {
  let generation = 0;
  fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (winner) => {
    const state = path.join(root, `concurrent-key-${generation++}`);
    const link = fs.linkSync;
    const publish = vi.spyOn(fs, "linkSync").mockImplementationOnce((temporary, destination) => {
      expect(fs.readFileSync(temporary).length).toBe(32);
      fs.writeFileSync(destination, winner, { flag: "wx", mode: 0o600 });
      link(temporary, destination);
    });
    try {
      const first = createFileKeyEncryption(state);
      const second = createFileKeyEncryption(state);
      expect(second.decryptString(first.encryptString("accepted winner"))).toBe("accepted winner");
      expect(fs.readFileSync(path.join(state, HEADLESS_SECRET_KEY_FILENAME))).toEqual(Buffer.from(winner));
      expect(fs.readdirSync(state)).toEqual([HEADLESS_SECRET_KEY_FILENAME]);
    } finally { publish.mockRestore(); }
  }));
});
