import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileBackedSafeStorageSecretStore } from "../settings/desktop-secret-store";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createTempFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragnt-secrets-"));
  tempRoots.push(root);
  return path.join(root, "settings-secrets.json");
}

describe("FileBackedSafeStorageSecretStore", () => {
  it("stores encrypted records outside the desktop TOML config", async () => {
    const safeStorage = {
      encryptString: vi.fn((value: string) =>
        Buffer.from(`encrypted:${value}`, "utf8"),
      ),
      decryptString: vi.fn((value: Buffer) =>
        value.toString("utf8").replace(/^encrypted:/, ""),
      ),
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: vi.fn(() => "os_crypt"),
    };
    const filePath = createTempFile();
    const store = new FileBackedSafeStorageSecretStore(safeStorage, filePath);

    await store.setSecret("telegramBotToken", "123456789:token");

    const contents = fs.readFileSync(filePath, "utf8");
    expect(contents).not.toContain("123456789:token");
    await expect(store.getSecret("telegramBotToken")).resolves.toBe(
      "123456789:token",
    );
  });

  it("marks basic_text safeStorage as unavailable", async () => {
    const store = new FileBackedSafeStorageSecretStore(
      {
        encryptString: vi.fn(),
        decryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
        getSelectedStorageBackend: vi.fn(() => "basic_text"),
      },
      createTempFile(),
    );

    expect(store.describe()).toMatchObject({
      available: false,
      backend: "safeStorage",
      encrypted: false,
    });
    await expect(store.setSecret("grokApiKey", "xai-secret")).rejects.toThrow(
      "basic_text",
    );
  });
});
