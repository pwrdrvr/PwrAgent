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
