/**
 * Only the conventional `<home>/.codex` root is abbreviated; a `CODEX_HOME`
 * pointed somewhere else is shown in full rather than given a misleading `~`.
 */
export function shortenCodexHome(value: string, homeDir: string | undefined): string {
  if (!homeDir) return value;

  const windows = /^[a-z]:[/\\]|^\\\\|^\/\//i.test(homeDir);
  if (!windows && !homeDir.startsWith("/")) return value;
  const home = (windows ? homeDir.replaceAll("\\", "/") : homeDir)
    .replace(/\/+$/, "");
  const normalized = windows ? value.replaceAll("\\", "/") : value;
  const root = `${home}/.codex`;
  const comparableValue = windows ? normalized.toLowerCase() : normalized;
  const comparableRoot = windows ? root.toLowerCase() : root;
  if (
    comparableValue !== comparableRoot
    && !comparableValue.startsWith(`${comparableRoot}/`)
  ) {
    return value;
  }
  // Preserve the original separators, casing and trailing slash in the tail.
  return `~${value.slice(home.length)}`;
}
