import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, expect, it, vi } from "vitest";
import { getOwnerHostServices } from "../owner-host";
import { createFileKeyEncryption } from "../headless/file-key-encryption";
import { tagSecretEncryption } from "../settings/secret-encryption-envelope";
import { CloudflareAccessOAuth } from "../federation/cloudflare-access-oauth";
import { loadCloudflareAccessSession, saveCloudflareAccessSession, loadCloudflareSetup, saveCloudflareSetup } from "../federation/cloudflare-setup-storage";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../settings/desktop-config", () => ({ resolveDesktopConfigPath: () => `${fixture.root}/config.toml` }));
fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudflare-host-secrets-"));
afterAll(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
const desktop = tagSecretEncryption({
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "keychain",
  encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString(),
}, "desktop-safe-storage");
const headless = createFileKeyEncryption(path.join(fixture.root, "headless-key"));

it.each([
  { writer: desktop, reader: headless, name: "desktop to headless", reason: "desktop OS keychain" },
  { writer: headless, reader: desktop, name: "headless to desktop", reason: "headless host's file key" },
])("$name keeps Cloudflare ciphertext and exposes why sign-in is unavailable", async ({ writer, reader, reason }) => {
  vi.stubEnv("PWRAGENT_DEV_DISABLE_SECRET_STORAGE", undefined);
  await fc.assert(fc.asyncProperty(fc.string({ minLength: 1 }), async (token) => {
    const host = getOwnerHostServices();
    host.secrets = writer;
    const endpoint = "https://invented-access.pwragent.test";
    await saveCloudflareAccessSession({ version: 1, endpoint, accessToken: token });
    await saveCloudflareSetup({ version: 1, verifier: { token }, clients: [] } as never);
    const sessionFile = path.join(fixture.root, "state/cloudflare-access-session.enc");
    const setupFile = path.join(fixture.root, "state/cloudflare-federation.enc");
    const before = [fs.readFileSync(sessionFile), fs.readFileSync(setupFile)];
    host.secrets = reader;
    const oauth = new CloudflareAccessOAuth({ load: loadCloudflareAccessSession, save: saveCloudflareAccessSession, openExternal: async () => {} });
    expect(await oauth.status(endpoint)).toMatchObject({ state: "sign-in-required", lastError: expect.stringContaining(reason) });
    await expect(oauth.accessToken(endpoint)).rejects.toThrow(reason);
    await expect(loadCloudflareSetup()).rejects.toThrow(reason);
    expect([fs.readFileSync(sessionFile), fs.readFileSync(setupFile)]).toEqual(before);
  }), { numRuns: 12 });
});
