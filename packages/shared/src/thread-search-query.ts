import type { LinkedDirectorySummary } from "./contracts/normalized-app-server";

/** Mentions are whitespace-delimited; quoted text stays literal. */
export function parseThreadSearchQuery(input: string): { query: string; projects: string[] } {
  const projects: string[] = [];
  const tokens = input.match(/(?:in:)?@"[^"]+"(?=\s|$)|"[^"]*"(?=\s|$)|\S+/gi) ?? [];
  const text = tokens.filter((token) => {
    const mention = /^(?:in:)?@(?:"([^"]+)"|([^\s"@]+))$/i.exec(token);
    if (!mention) return true;
    projects.push((mention[1] ?? mention[2]).toLowerCase());
    return false;
  });
  return { query: projects.length ? text.join(" ") : input.trim(), projects: [...new Set(projects)] };
}

/** Case-insensitive prefixes of project names, directory labels or full paths. */
export function matchesThreadSearchProjects(
  thread: { projectKey?: string; linkedDirectories?: readonly LinkedDirectorySummary[] },
  projects: readonly string[],
): boolean {
  if (!projects.length) return true;
  const values = [thread.projectKey, ...(thread.linkedDirectories ?? []).flatMap(
    (directory) => [directory.label, directory.path, directory.worktreePath],
  )].filter((value): value is string => Boolean(value));
  return projects.some((project) => values.some((value) => {
    const path = value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name.startsWith(project) || path.startsWith(project.replaceAll("\\", "/"));
  }));
}

/** Decode text only after project mentions have been extracted. Do not reparse
 * decoded literals as mentions: quoted "@disk" must remain searchable text.
 */
export function threadSearchTextTerms(query: string): { text: string; quoted: boolean }[] {
  return (query.match(/"[^"]*"|[^\s"]+/g) ?? []).map((token) => ({
    text: token.startsWith('"') ? token.slice(1, -1) : token,
    quoted: token.startsWith('"'),
  })).filter((term) => term.text.length > 0);
}
