/**
 * Only the conventional `<home>/.codex` root is abbreviated; a `CODEX_HOME`
 * pointed somewhere else is shown in full rather than given a misleading `~`.
 */
export function shortenCodexHome(value: string, _homeDir: string | undefined): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/$/, "");
  const match = /^.*?(\/\.codex(?:\/.*)?)$/.exec(normalized);
  return match ? `~${match[1]}` : normalized;
}
