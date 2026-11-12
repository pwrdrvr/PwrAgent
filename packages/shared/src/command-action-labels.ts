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
