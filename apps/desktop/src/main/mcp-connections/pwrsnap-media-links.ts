import {
  isPwrSnapResourceUri,
  MAX_TRANSCRIPT_IMAGE_BYTES,
  PWRSNAP_MCP_CONNECTION_ID,
} from "@pwragent/shared";

/** Links remembered per session. The oldest are forgotten first. */
export const MAX_PWRSNAP_MEDIA_LINKS_PER_SESSION = 512;

/**
 * Which `pwrsnap://` image links each live PwrSnap session returned.
 *
 * PwrSnap delivers media only through `resources/read` on the session that
 * returned the link, and every read rechecks that session's capabilities,
 * history horizon and budget. PwrAgent adds its own rule before it asks:
 * a transcript image is read only through the PwrSnap session that returned
 * it, for that session's own thread, while that session is still live. A
 * link the model wrote, another server returned, or an ended session
 * returned is never read, and no new session is opened to read it, since a
 * new session would raise a fresh PwrSnap approval.
 *
 * A session is identified by its token (one per thread and connection) and
 * by the session object itself, so a session reopened on the same token does
 * not inherit the links of the one before it.
 */
export class PwrSnapMediaLinks {
  private readonly sessions = new Map<string, { session: object; uris: Set<string> }>();

  /** Record the image links in one tool result from the session on `token`. */
  record(token: string, connectionId: string, session: object, result: unknown): void {
    if (connectionId !== PWRSNAP_MCP_CONNECTION_ID) return;
    const uris = readPwrSnapImageLinks(result);
    if (uris.length === 0) return;
    let entry = this.sessions.get(token);
    if (!entry || entry.session !== session) {
      entry = { session, uris: new Set() };
      this.sessions.set(token, entry);
    }
    for (const uri of uris) {
      entry.uris.delete(uri);
      entry.uris.add(uri);
      if (entry.uris.size > MAX_PWRSNAP_MEDIA_LINKS_PER_SESSION) {
        const oldest = entry.uris.values().next().value;
        if (oldest !== undefined) entry.uris.delete(oldest);
      }
    }
  }

  /** The session on `token` ended; its links are never read again. */
  forget(token: string): void {
    this.sessions.delete(token);
  }

  /**
   * The token of the live session that returned `uri` to `threadId`, if any.
   * `liveSession` answers the session currently open on a token, and
   * `threadOf` the thread a token serves.
   */
  resolve(
    threadId: string,
    uri: string,
    lookup: {
      liveSession: (token: string) => object | undefined;
      threadOf: (token: string) => string | undefined;
    },
  ): string | undefined {
    for (const [token, entry] of this.sessions) {
      if (!entry.uris.has(uri)) continue;
      if (lookup.threadOf(token) !== threadId) continue;
      if (lookup.liveSession(token) !== entry.session) continue;
      return token;
    }
    return undefined;
  }
}

/** The `pwrsnap://` image resource links in an MCP tool result's content. */
export function readPwrSnapImageLinks(result: unknown): string[] {
  const content = result && typeof result === "object"
    ? (result as { content?: unknown }).content
    : undefined;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): string[] => {
    if (!block || typeof block !== "object") return [];
    const { type, uri, mimeType } = block as Record<string, unknown>;
    return type === "resource_link"
      && typeof uri === "string"
      && typeof mimeType === "string"
      && mimeType.toLowerCase().startsWith("image/")
      && isPwrSnapResourceUri(uri)
      ? [uri]
      : [];
  });
}

/**
 * What a transcript gets for one PwrSnap image link. `session-ended` covers
 * every link PwrAgent will not read: no live PwrSnap session on the thread
 * returned it.
 */
export type PwrSnapMediaRead =
  | { ok: true; mimeType: string; dataBase64: string }
  | { ok: false; reason: "session-ended" | "failed" };

/** The image a `resources/read` result holds for `uri`, if it holds one. */
export function readPwrSnapImageContents(result: unknown, uri: string): PwrSnapMediaRead {
  const contents = result && typeof result === "object"
    ? (result as { contents?: unknown }).contents
    : undefined;
  if (!Array.isArray(contents)) return { ok: false, reason: "failed" };
  for (const entry of contents) {
    if (!entry || typeof entry !== "object") continue;
    const { uri: entryUri, mimeType, blob } = entry as Record<string, unknown>;
    if (entryUri !== uri || typeof blob !== "string" || typeof mimeType !== "string") continue;
    const type = mimeType.split(";", 1)[0]!.trim().toLowerCase();
    if (!type.startsWith("image/")) continue;
    if (blob.length === 0 || blob.length > Math.ceil(MAX_TRANSCRIPT_IMAGE_BYTES / 3) * 4) continue;
    return { ok: true, mimeType: type, dataBase64: blob };
  }
  return { ok: false, reason: "failed" };
}
