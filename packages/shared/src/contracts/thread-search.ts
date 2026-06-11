import type {
  AppServerBackendKind,
  AppServerBackendScope,
  AppServerThreadTitleSource,
  LinkedDirectorySummary,
  ThreadIdentifier,
} from "./normalized-app-server";

export const DEFAULT_THREAD_SEARCH_LIMIT = 20;
export const MAX_THREAD_SEARCH_LIMIT = 100;

export const THREAD_SEARCH_CONTENT_MODES = [
  "metadata",
  "available",
  "required",
] as const;

export type ThreadSearchContentMode =
  (typeof THREAD_SEARCH_CONTENT_MODES)[number];

export const THREAD_SEARCH_SEMANTIC_MODES = [
  "disabled",
  "available",
  "required",
] as const;

export type ThreadSearchSemanticMode =
  (typeof THREAD_SEARCH_SEMANTIC_MODES)[number];

export const THREAD_SEARCH_CONFIDENCE_BANDS = [
  "high",
  "medium",
  "low",
] as const;

export type ThreadSearchConfidenceBand =
  (typeof THREAD_SEARCH_CONFIDENCE_BANDS)[number];

export const THREAD_SEARCH_SCOPE_NAMES = [
  "metadata",
  "projection",
  "provider_content",
  "semantic",
] as const;

export type ThreadSearchScopeName = (typeof THREAD_SEARCH_SCOPE_NAMES)[number];

export const THREAD_SEARCH_MATCH_REASON_KINDS = [
  "exact_title",
  "title_token_overlap",
  "summary_match",
  "project_match",
  "directory_match",
  "path_match",
  "branch_match",
  "backend_match",
  "model_match",
  "time_filter",
  "archive_filter",
  "provider_content_match",
  "semantic_match",
  "recent_activity",
] as const;

export type ThreadSearchMatchReasonKind =
  (typeof THREAD_SEARCH_MATCH_REASON_KINDS)[number];

export type ThreadSearchDateRange = {
  from?: number;
  to?: number;
};

export type ThreadSearchFilters = {
  backend?: AppServerBackendScope;
  includeArchived?: boolean;
  dateRange?: ThreadSearchDateRange;
  projectKeys?: string[];
  directoryIds?: string[];
  directoryPaths?: string[];
  models?: string[];
};

export type ThreadSearchRequest = {
  query?: string;
  filters?: ThreadSearchFilters;
  limit?: number;
  contentMode?: ThreadSearchContentMode;
  semanticMode?: ThreadSearchSemanticMode;
};

export type ThreadSearchMatchReason = {
  kind: ThreadSearchMatchReasonKind;
  field?: string;
  value?: string;
  weight?: number;
};

export type ThreadSearchSnippet = {
  scope: ThreadSearchScopeName;
  field?: string;
  text: string;
  truncated?: boolean;
};

export type ThreadSearchUnavailableScope = {
  scope: ThreadSearchScopeName;
  backend?: AppServerBackendKind;
  reason:
    | "disabled"
    | "unsupported"
    | "not_configured"
    | "not_indexed"
    | "error";
  message: string;
};

export type ThreadSearchResult = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  identityKey: string;
  title: string;
  titleSource?: AppServerThreadTitleSource;
  summary?: string;
  projectKey?: string;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number;
  linkedDirectories: LinkedDirectorySummary[];
  source: AppServerBackendKind;
  gitBranch?: string;
  model?: string;
  score: number;
  confidence: ThreadSearchConfidenceBand;
  matchReasons: ThreadSearchMatchReason[];
  snippets: ThreadSearchSnippet[];
};

export type ThreadSearchResponse = {
  backend: AppServerBackendScope;
  fetchedAt: number;
  query: string;
  filters: ThreadSearchFilters;
  contentMode: ThreadSearchContentMode;
  semanticMode: ThreadSearchSemanticMode;
  results: ThreadSearchResult[];
  searchedScopes: ThreadSearchScopeName[];
  unavailableScopes: ThreadSearchUnavailableScope[];
  truncated?: boolean;
};

export function isThreadSearchContentMode(
  value: unknown,
): value is ThreadSearchContentMode {
  return (
    typeof value === "string" &&
    THREAD_SEARCH_CONTENT_MODES.includes(value as ThreadSearchContentMode)
  );
}

export function isThreadSearchSemanticMode(
  value: unknown,
): value is ThreadSearchSemanticMode {
  return (
    typeof value === "string" &&
    THREAD_SEARCH_SEMANTIC_MODES.includes(value as ThreadSearchSemanticMode)
  );
}

export function normalizeThreadSearchLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_THREAD_SEARCH_LIMIT;
  }
  const whole = Math.floor(value);
  if (whole < 1) {
    return 1;
  }
  return Math.min(whole, MAX_THREAD_SEARCH_LIMIT);
}

export function normalizeThreadSearchContentMode(
  value: unknown,
): ThreadSearchContentMode {
  return isThreadSearchContentMode(value) ? value : "available";
}

export function normalizeThreadSearchSemanticMode(
  value: unknown,
): ThreadSearchSemanticMode {
  return isThreadSearchSemanticMode(value) ? value : "disabled";
}
