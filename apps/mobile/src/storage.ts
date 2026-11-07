import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import type { MobileCredential } from "../../../packages/shared/src/mobile-gateway";
import type { OutboxEntry, OutboxStorage } from "./outbox";

const CREDENTIAL_KEY = "pwragent.gateway.v1";
export const credentials = {
  async read(): Promise<MobileCredential | undefined> {
    const value = await SecureStore.getItemAsync(CREDENTIAL_KEY);
    return value ? JSON.parse(value) as MobileCredential : undefined;
  },
  async write(value: MobileCredential): Promise<void> {
    await SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify(value), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  },
  async clear(): Promise<void> { await SecureStore.deleteItemAsync(CREDENTIAL_KEY); },
};
/** Immutable generations: incomplete staging writes never replace valid data.
 * One write + rename per enqueue or changed receipt; no streamed-event writes. */
function snapshots(): File[] {
  return new Directory(Paths.document).list().filter((entry): entry is File =>
    entry instanceof File && /^outbox-v1-\d+\.json$/.test(entry.name))
    .sort((a, b) => Number(b.name.slice(10, -5)) - Number(a.name.slice(10, -5)));
}
export const outboxStorage: OutboxStorage = {
  async read() {
    const files = snapshots();
    if (!files.length) return [];
    // Corruption is visible and blocks sending; never silently lose an outbox.
    return JSON.parse(await files[0]!.text()) as OutboxEntry[];
  },
  async write(entries) {
    const previous = snapshots();
    const sequence = previous.length ? Number(previous[0]!.name.slice(10, -5)) + 1 : 1;
    const temporary = new File(Paths.document, "outbox-v1.staging");
    temporary.write(JSON.stringify(entries));
    temporary.move(new File(Paths.document, `outbox-v1-${sequence}.json`));
    // A crash during cleanup leaves extra valid generations, not lost messages.
    for (const old of previous.slice(1)) { try { old.delete(); } catch { /* Retry on the next boundary write. */ } }
  },
};
