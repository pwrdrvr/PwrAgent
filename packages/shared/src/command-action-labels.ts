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
