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

/**
 * The account behind a Codex model provider: the endpoint's origin and a
 * digest of its key. Two providers with the same origin and key are one
 * account; a different key or origin is a different one. The key itself is
 * never part of what is stored, only this one-way digest of a digest.
 */
export function codexModelProviderAccountKey(baseUrl: string, apiKey: string | undefined): string {
  let origin = baseUrl;
  try {
    const url = new URL(baseUrl);
    origin = `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    // Validation rejects such URLs; keep the raw string as a stable fallback.
  }
  const keyDigest = apiKey ? createHash("sha256").update(apiKey).digest("hex") : "";
  return createHash("sha256").update(`codex-model-provider\u0000${origin}\u0000${keyDigest}`)
    .digest("hex").slice(0, 32);
}
