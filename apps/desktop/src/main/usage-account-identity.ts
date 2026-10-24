import { createHash } from "node:crypto";
import type { BackendAccountSummary } from "@pwragent/shared";

/** Never use a generic provider label, profile path, or credential as identity. */
export function usageAccountKey(
  account: BackendAccountSummary | undefined,
  group?: string,
): string | undefined {
  const explicit = group?.trim();
  if (explicit) {
    return createHash("sha256").update(`group\u0000${explicit}`).digest("hex").slice(0, 32);
  }
  if (account?.accountId) {
    return createHash("sha256").update(`account-id\u0000${account.type ?? ""}\u0000${account.accountId}`)
      .digest("hex").slice(0, 32);
  }
  // Older App Servers expose email only. Keep the existing hash for these
  // versions so their recorded limit history still matches their usage.
  if (account?.type === "chatgpt" && account.email) {
    return createHash("sha256").update(`${account.type}\u0000${account.email}`)
      .digest("hex").slice(0, 16);
  }
  return undefined;
}
