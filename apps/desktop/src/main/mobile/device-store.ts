import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MobileScope } from "../../../../../packages/shared/src/mobile-gateway";

export type MobileDevice = { id: string; name: string; tokenHash: string; scopes: MobileScope[]; machines: string[] | "all"; revoked?: boolean };
type Invite = { hash: string; expiresAt: number; scopes: MobileScope[]; machines: string[] | "all" };
type Store = { devices: MobileDevice[]; invites: Invite[] };
export const tokenHash = (value: string): string => createHash("sha256").update(value).digest("hex");
function matches(value: string, expected: string): boolean {
  const actual = Buffer.from(tokenHash(value), "hex");
  const hash = Buffer.from(expected, "hex");
  return hash.length === actual.length && timingSafeEqual(actual, hash);
}
/** Credentials are stored only as hashes. The phone keeps the bearer in Keychain. */
export class MobileDeviceStore {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  private async read(): Promise<Store> {
    try { return JSON.parse(await readFile(this.file, "utf8")) as Store; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { devices: [], invites: [] }; throw error; }
  }
  private transaction<T>(action: (store: Store) => T): Promise<T> {
    const next = this.serial.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      // The operator CLI and running gateway can write this store. An exclusive
      // lock prevents an invite or revocation from overwriting a paired device.
      const lock = await open(`${this.file}.lock`, "wx", 0o600).catch(() => { throw new Error("Device store busy; retry. A crashed writer may have left its .lock file."); });
      try {
        await lock.writeFile(String(process.pid));
        const store = await this.read(); const result = action(store);
        const temp = `${this.file}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(store), { mode: 0o600 });
        await rename(temp, this.file);
        return result;
      } finally { await lock.close(); await unlink(`${this.file}.lock`); }
    });
    this.serial = next.catch(() => undefined); return next;
  }
  async invite(scopes: MobileScope[], machines: string[] | "all"): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.transaction((store) => {
      store.invites = store.invites.filter((invite) => invite.expiresAt > Date.now());
      store.invites.push({ hash: tokenHash(token), scopes, machines, expiresAt: Date.now() + 10 * 60_000 });
    });
    return token;
  }
  async pair(inviteToken: string, name: string): Promise<{ device: MobileDevice; token: string }> {
    return this.transaction((store) => {
      const index = store.invites.findIndex((invite) => invite.expiresAt > Date.now() && matches(inviteToken, invite.hash));
      if (index < 0) throw new Error("Pairing code expired or already used");
      const invite = store.invites[index]!;
      const token = randomBytes(32).toString("base64url");
      const device: MobileDevice = { id: randomUUID(), name: name.slice(0, 80), tokenHash: tokenHash(token), scopes: invite.scopes, machines: invite.machines };
      store.devices.push(device); store.invites.splice(index, 1);
      return { device, token };
    });
  }
  async authenticate(token: string): Promise<MobileDevice | undefined> {
    if (token.length > 256) return undefined;
    return (await this.read()).devices.find((device) => !device.revoked && matches(token, device.tokenHash));
  }
  async revoke(id: string): Promise<void> {
    await this.transaction((store) => { const device = store.devices.find((row) => row.id === id); if (device) device.revoked = true; });
  }
}
