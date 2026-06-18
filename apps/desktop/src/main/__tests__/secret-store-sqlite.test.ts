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
  });

  it("clears the unusable marker after replacing the secret", async () => {
    let ciphertext: Buffer<ArrayBufferLike> = Buffer.from("old");
    const stateDb = {
      getSecret: vi.fn(() => ciphertext),
      setSecret: vi.fn((_name: string, nextCiphertext: Buffer) => {
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
  });
});
