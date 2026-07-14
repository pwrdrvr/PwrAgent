/**
 * Compact display of absolute filesystem paths by collapsing the user's
 * home directory to `~` (`/Users/foo/dev/app` → `~/dev/app`). The home
 * directory is surfaced synchronously by the main process through the
 * preload (`window.__pwragentHomeDir`); see `home-dir-bootstrap` /
 * `preload/index.ts`.
 */

/** The OS home directory main surfaced via the preload, if available. */
export function getHomeDir(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const value = (window as unknown as { __pwragentHomeDir?: unknown })
    .__pwragentHomeDir;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Replaces a leading home-directory prefix with `~`. Returns the path
 * unchanged when it doesn't live under home, or when the home directory is
 * unknown (e.g. in tests, or before the preload value is present).
 *
 * Separator-tolerant so a forward-slashed app path still matches a
 * back-slashed Windows home directory.
 */
export function tildifyPath(
  absolutePath: string,
  homeDir: string | undefined = getHomeDir(),
): string {
  if (!absolutePath || !homeDir) {
    return absolutePath;
  }
  const home = homeDir.replace(/[/\\]+$/, "");
  if (!home) {
    return absolutePath;
  }
  const normalizedPath = absolutePath.replace(/\\/g, "/");
  const normalizedHome = home.replace(/\\/g, "/");
  if (normalizedPath === normalizedHome) {
    return "~";
  }
  if (normalizedPath.startsWith(`${normalizedHome}/`)) {
    return `~${absolutePath.slice(home.length)}`;
  }
  return absolutePath;
}

/**
 * Inverse of tildifyPath: expands a leading `~` to the home directory.
 * Returns the path unchanged when it doesn't start with `~` or when the
 * home directory is unknown.
 */
export function expandTildePath(
  path: string,
  homeDir: string | undefined = getHomeDir(),
): string {
  if (!path || !homeDir || !path.startsWith("~")) {
    return path;
  }
  const home = homeDir.replace(/[/\\]+$/, "");
  if (!home) {
    return path;
  }
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return `${home}${path.slice(1)}`;
  }
  return path;
}
