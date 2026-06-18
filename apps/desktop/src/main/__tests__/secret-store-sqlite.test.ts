import { describe, expect, it, vi } from "vitest";
import { DbBackedSafeStorageSecretStore } from "../state/secret-store-sqlite";

describe("DbBackedSafeStorageSecretStore", () => {
  it("does not report a stored row as configured after decryption fails", async () => {
    const ciphertext = Buffer.from("encrypted");
    const stateDb = {
      getSecret: vi.fn(() => ciphertext),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    };
    const safeStorage = {
      encryptString: vi.fn((value: string) => Buffer.from(value)),
      decryptString: vi.fn(() => {
        throw new Error("cannot decrypt");
      }),
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: vi.fn(() => "keychain"),
    };
    const store = new DbBackedSafeStorageSecretStore(
      safeStorage,
      stateDb as never,
    );

    expect(await store.hasSecret("grokApiKey")).toBe(true);
    expect(store.getSecretSync("grokApiKey")).toBeUndefined();
    expect(await store.hasSecret("grokApiKey")).toBe(false);
    expect(store.getSecretAccessError("grokApiKey")).toContain(
      "could not unlock secret storage",
    );
  });

  it("clears the secret access error after replacing the secret", async () => {
    let ciphertext: Buffer<ArrayBufferLike> = Buffer.from("old");
    const stateDb = {
      getSecret: vi.fn(() => ciphertext),
      setSecret: vi.fn((_name: string, nextCiphertext: Buffer<ArrayBufferLike>) => {
        ciphertext = nextCiphertext;
      }),
      deleteSecret: vi.fn(),
    };
    const safeStorage = {
      encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
      decryptString: vi.fn(() => {
        throw new Error("cannot decrypt");
      }),
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: vi.fn(() => "keychain"),
    };
    const store = new DbBackedSafeStorageSecretStore(
      safeStorage,
      stateDb as never,
    );

    expect(store.getSecretSync("grokApiKey")).toBeUndefined();
    expect(await store.hasSecret("grokApiKey")).toBe(false);

    await store.setSecret("grokApiKey", "replacement");

    expect(await store.hasSecret("grokApiKey")).toBe(true);
    expect(store.getSecretAccessError("grokApiKey")).toBeUndefined();
  });

  it("throws a clear error and does not write when encryption is denied", async () => {
    const stateDb = {
      getSecret: vi.fn(() => undefined),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    };
    const safeStorage = {
      encryptString: vi.fn(() => {
        throw new Error("user denied keychain access");
      }),
      decryptString: vi.fn(),
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: vi.fn(() => "keychain"),
    };
    const store = new DbBackedSafeStorageSecretStore(
      safeStorage,
      stateDb as never,
    );

    await expect(store.setSecret("grokApiKey", "replacement")).rejects.toThrow(
      "could not unlock secret storage",
    );

    expect(stateDb.setSecret).not.toHaveBeenCalled();
    expect(store.getSecretAccessError("grokApiKey")).toContain(
      "could not unlock secret storage",
    );
  });
});
