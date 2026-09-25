/**
 * Gate for handing a URL to the OS via `shell.openExternal`.
 *
 * PwrAgent's own `pwragent:` scheme is deliberately NOT allowed here. Thread
 * links are resolved in-app by the transcript renderer, which intercepts the
 * click and navigates; they must never round-trip out through the OS.
 */
export function isSafeExternalOpenUrl(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (
    parsed.protocol === "https:"
    || parsed.protocol === "mailto:"
    || parsed.protocol === "file:"
  ) {
    return true;
  }

  return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "127.0.0.1"
    || normalized === "::1"
  );
}

/**
 * Gate for the one `slack:` link PwrAgent opens: a direct message with the
 * connected Slack app, built by main from IDs Slack returned. It is kept out
 * of `isSafeExternalOpenUrl`, which also vets links from rendered markdown,
 * where a `slack:` scheme has no business being opened.
 */
export function isSlackAppDeepLink(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const keys = [...parsed.searchParams.keys()].sort().join(",");
  return (
    parsed.protocol === "slack:"
    && parsed.hostname === "app"
    && parsed.pathname === ""
    && parsed.hash === ""
    && keys === "id,tab,team"
    && /^A[A-Z0-9]{6,20}$/u.test(parsed.searchParams.get("id") ?? "")
    && /^[TE][A-Z0-9]{6,20}$/u.test(parsed.searchParams.get("team") ?? "")
    && parsed.searchParams.get("tab") === "messages"
  );
}
