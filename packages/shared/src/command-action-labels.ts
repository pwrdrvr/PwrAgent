const MAX_SEARCH_QUERY_LENGTH = 61;

export function formatSearchCommandActionLabel(params: {
  path?: string | null;
  query?: string | null;
}): string {
  const query = normalizeLabelText(params.query);
  if (query) {
    const displayQuery =
      query.length > MAX_SEARCH_QUERY_LENGTH
        ? `${query.slice(0, MAX_SEARCH_QUERY_LENGTH - 3)}...`
        : query;
    return `Searched "${displayQuery}"`;
  }

  const pathName = readMeaningfulPathName(params.path);
  return pathName ? `Searched ${pathName}` : "Searched";
}

/**
 * The label of a web search row, live and replayed. It reads as a search,
 * so its activity header counts it in the exploration part.
 */
export function formatWebSearchLabel(inProgress: boolean): string {
  return inProgress ? "Searching Web" : "Searched Web";
}

export type ExplorationCounts = {
  /** Distinct files read. Reading one file twice is one file. */
  files?: number;
  searches?: number;
  lists?: number;
  /** Read-kind rows that are none of the above, such as a fetched page. */
  items?: number;
};

/**
 * The exploration part of an activity header: "Explored 2 files, 1 search".
 * Each noun counts what its rows did, so a search over a directory is a
 * search, never a file.
 */
export function formatExplorationSummary(counts: ExplorationCounts): string | undefined {
  const parts = [
    countNoun(counts.files, "file", "files"),
    countNoun(counts.searches, "search", "searches"),
    countNoun(counts.lists, "list", "lists"),
    countNoun(counts.items, "item", "items"),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `Explored ${parts.join(", ")}` : undefined;
}

/**
 * Which exploration a read-kind row records, from the label the command
 * action builders write ("Read a.ts", "Searched \"q\"", "Listed src"). A
 * search still running ("Searching Web: q") is already a search.
 */
export function classifyExplorationLabel(
  label: string,
): "file" | "search" | "list" | undefined {
  const trimmed = label.trim();
  if (/^Read\s/.test(trimmed)) {
    return "file";
  }
  if (/^Search(?:ed|ing)(?:\s|$)/.test(trimmed)) {
    return "search";
  }
  if (/^Listed(?:\s|$)/.test(trimmed)) {
    return "list";
  }
  return undefined;
}

function countNoun(
  count: number | undefined,
  singular: string,
  plural: string,
): string | undefined {
  return count && count > 0 ? `${count} ${count === 1 ? singular : plural}` : undefined;
}

function normalizeLabelText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function readMeaningfulPathName(value: string | null | undefined): string | undefined {
  const normalized = normalizeLabelText(value)
    ?.replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || /^[a-z]:$/i.test(normalized)
  ) {
    return undefined;
  }

  return normalized.split("/").filter(Boolean).pop();
}

const MAX_COMMAND_LABEL_LENGTH = 72;

// Strip a leading shell-interpreter wrapper so we show the command the agent
// actually ran rather than the interpreter's full path. Handles POSIX login
// shells (`/bin/sh -lc <cmd>`, `bash -lc <cmd>`) and Windows interpreters
// (`"C:\...\powershell.exe" -Command <cmd>`, `cmd.exe /c <cmd>`,
// `bash.exe -lc <cmd>`). The full, unmodified command is preserved separately
// as `rawCommand` for the expanded details view.
//
// The Windows branch matches the interpreter path in two forms: quoted
// (`"[^"]*…\.exe"`, which permits spaces — e.g. `"C:\Program Files\Git\bin\
// bash.exe"`) and unquoted (`[^\s"]*…\.exe`, no spaces). A single
// `[^\s"]*` couldn't span a spaced path inside quotes, so a quoted Git-bash
// invocation under "Program Files" would otherwise show the full path.
function stripShellWrapper(command: string): string {
  return command
    .trim()
    .replace(/^(?:\/\S+\/)?(?:ba|z)?sh\s+-lc\s+/i, "")
    .replace(
      /^(?:"[^"]*(?:powershell|pwsh|cmd|bash)\.exe"|[^\s"]*(?:powershell|pwsh|cmd|bash)\.exe)\s+(?:-Command|-lc|-c|\/d\s+\/s\s+\/c|\/c)\s+/i,
      "",
    )
    .trim();
}

/** A command on one line, without its shell wrapper or outer quotes. */
export function normalizeCommandText(command: string): string {
  return stripShellWrapper(command)
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The label of a command row, live and replayed: one line of at most 72
 * characters. A multi-line script would otherwise fill the transcript as the
 * row's heading; the full command stays in the row's expanded details.
 */
export function formatCommandLabel(command: string | undefined): string {
  const collapsed = command ? normalizeCommandText(command) : "";
  if (!collapsed) {
    return "Ran command";
  }
  return collapsed.length > MAX_COMMAND_LABEL_LENGTH
    ? `${collapsed.slice(0, MAX_COMMAND_LABEL_LENGTH - 3)}...`
    : collapsed;
}
