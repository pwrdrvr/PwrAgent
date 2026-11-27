import { createHash } from "node:crypto";
import type { NavigationQueryPage } from "@pwragent/shared/contracts/navigation";

export type PageFingerprints = { hashes: string[]; order: string[] };

/** Compare the whole enriched payload. A move can reuse it with a new opaque order key. */
export function navigationPageFingerprints(page: NavigationQueryPage): PageFingerprints {
  const rows = page.entries.length ? page.entries : page.modelGroups ?? page.directories ?? page.entries;
  const hashes = rows.map((item) => {
    const payload = "orderKey" in item ? { ...item, orderKey: undefined } : item;
    return createHash("sha256").update(JSON.stringify(payload)).digest("base64url");
  });
  return { hashes, order: page.entries.map(entry => entry.orderKey) };
}

export function navigationPageSlots(previous: PageFingerprints, current: PageFingerprints) {
  const positions = new Map(previous.hashes.map((hash, position) => [hash, position]));
  const slots = current.hashes.map((hash) => {
    const slot = positions.get(hash) ?? -1;
    positions.delete(hash);
    return slot;
  });
  const orderKeys: Record<number, string> = {};
  for (const [i, value] of current.order.entries()) {
    const slot = slots[i]!;
    if (slot >= 0 && value !== previous.order[slot]) orderKeys[i] = value;
  }
  return { slots, orderKeys };
}
