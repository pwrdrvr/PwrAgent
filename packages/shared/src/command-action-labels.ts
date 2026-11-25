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

function readPosixScriptWord(text: string): { length: number; display: string; echoes: string[] } | undefined {
  let length = 0;
  let decodedScript = "";
  let escapedScript = "";
  // Adjacent quoted and escaped fragments form one word. Sticky matching
  // stops at the first separator so a trailing argument never joins it.
  for (const [fragment, single, double, escaped] of text.matchAll(
    /'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"|\\([\s\S])|[^\s'"\\;&|<>()]+/gy,
  )) {
    const end = length + fragment.length;
    const literal = single ?? (escaped === "\n" ? "" : escaped);
    // Bash removes unquoted line continuations before recognizing $'…' or $"…".
    if (
      literal === undefined
      && double === undefined
      && fragment.endsWith("$")
      && /^(?:\\\n)*['"]/.test(text.slice(end))
    ) {
      return undefined;
    }
    const doubleEcho = double?.replace(/\\(["\\$`\n])/g, (_, char: string) =>
      char === "\n" ? "" : char,
    );
    const decoded = literal ?? doubleEcho ?? fragment;
    // Keep the existing display for a standalone double-quoted script.
    // Joined fragments use the decoded word that the shell passes to -c.
    if (double !== undefined && fragment.length === text.length) {
      return { length: end, display: double, echoes: [decoded, double] };
    }
    decodedScript += decoded;
    escapedScript += literal ?? double ?? fragment;
    length = end;
  }
  // A provider can echo the script with or without its outer shell escapes.
  return { length, display: decodedScript, echoes: [decodedScript, escapedScript] };
}

function readCommandLabelText(command: string): { display: string; scriptEchoes?: string[] } {
  const trimmed = command.trim();
  const posixWrapper = /^(?:\/\S+\/)?(?:ba|z)?sh\s+(-l?c|-C)\s+/.exec(trimmed);
  if (posixWrapper) {
    const tail = trimmed.slice(posixWrapper[0].length);
    const word = readPosixScriptWord(tail);
    if (!word) {
      return { display: trimmed };
    }
    let display = trimmed;
    // Noclobber's script path can be echoed as a title. Keep its flag visible.
    if (posixWrapper[1] !== "-C") {
      if (!/^['"]/.test(tail)) {
        display = tail;
      } else if (word.length === tail.length && word.display.trim()) {
        display = word.display;
      }
    }
    return word.length > 0 ? { display, scriptEchoes: word.echoes } : { display };
  }

  // Quoted Windows executable paths can contain spaces, as in Program Files.
  const unwrapped = trimmed
    .replace(
      /^(?:"[^"]*(?:powershell|pwsh|cmd|bash)\.exe"|[^\s"]*(?:powershell|pwsh|cmd|bash)\.exe)\s+(?:-Command|-lc|-c|\/d\s+\/s\s+\/c|\/c)\s+/i,
      "",
    )
    .trim();
  const display = unwrapped === trimmed
    ? unwrapped
    : unwrapped.replace(/^(['"])([\s\S]*)\1$/, "$2");
  return { display };
}

/** Unwraps a shell invocation for display while keeping the script's formatting. */
export function unwrapCommandText(command: string): string {
  return readCommandLabelText(command).display;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A command on one line for display. */
export function normalizeCommandText(command: string): string {
  return oneLine(unwrapCommandText(command));
}

/** Matches an echoed command title without changing which text is displayed. */
export function commandTitleMatchesInvocation(title: string, command: string): boolean {
  const candidate = normalizeCommandText(title);
  const { display, scriptEchoes } = readCommandLabelText(command);
  return candidate === oneLine(display)
    || (scriptEchoes?.some((echo) => candidate === oneLine(echo)) ?? false);
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
