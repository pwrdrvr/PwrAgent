const PWRSNAP_RESOURCE_SCHEME = "pwrsnap:";
const MAX_PWRSNAP_RESOURCE_URI_LENGTH = 2048;
const LEGACY_PWRSNAP_MEDIA_ORIGIN = "http://127.0.0.1:51729";

/**
 * PwrSnap 1.3 returns media as canonical `pwrsnap://` MCP resource links.
 * Their bytes come only from `resources/read` on the live session that
 * returned them, so this check says only what a link claims to be. Whether
 * PwrAgent may read it is the MCP gateway's decision.
 */
export function isPwrSnapResourceUri(value: string): boolean {
  if (value.length > MAX_PWRSNAP_RESOURCE_URI_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === PWRSNAP_RESOURCE_SCHEME
    && Boolean(parsed.host)
    && !parsed.username
    && !parsed.password;
}

/**
 * PwrSnap before 1.3 served signed media from a fixed loopback port. That
 * listener no longer exists, so these URLs are never requested: transcripts
 * that hold one show the image as unavailable.
 */
export function isLegacyPwrSnapMediaUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin === LEGACY_PWRSNAP_MEDIA_ORIGIN && parsed.pathname === "/media";
}
