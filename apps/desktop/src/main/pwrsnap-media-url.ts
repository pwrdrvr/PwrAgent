const PWRSNAP_MEDIA_ORIGIN = "http://127.0.0.1:51729";

/**
 * PwrSnap's local MCP server issues short-lived, signed media URLs from its
 * fixed loopback origin. Keep this narrow: transcript materialization fetches
 * these URLs from the main process, so accepting arbitrary loopback origins
 * would make an MCP result an SSRF primitive against local services.
 */
export function isPwrSnapSignedMediaUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return (
    parsed.origin === PWRSNAP_MEDIA_ORIGIN
    && parsed.pathname === "/media"
    && !parsed.username
    && !parsed.password
    && Boolean(parsed.searchParams.get("grant"))
    && Boolean(parsed.searchParams.get("signature"))
  );
}
