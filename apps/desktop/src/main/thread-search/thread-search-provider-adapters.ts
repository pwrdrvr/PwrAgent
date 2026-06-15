import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  ThreadSearchResult,
  ThreadSearchUnavailableScope,
} from "@pwragent/shared";

const DEFAULT_TRANSCRIPT_READ_LIMIT = 80;
const MAX_TRANSCRIPT_CANDIDATES = 50;

export type ThreadContentSearchRequest = {
  query: string;
  candidates: ThreadSearchResult[];
  limit: number;
};

export type ThreadContentSearchResponse = {
  results: ThreadSearchResult[];
  unavailableScopes: ThreadSearchUnavailableScope[];
};

export type ThreadTranscriptReader = (request: {
  backend: AppServerBackendKind;
  threadId: string;
  limit: number;
}) => Promise<AppServerReadThreadResponse>;

export class ProviderTranscriptThreadSearchAdapter {
  constructor(private readonly readThread: ThreadTranscriptReader) {}

  async searchContent(
    request: ThreadContentSearchRequest,
  ): Promise<ThreadContentSearchResponse> {
    const terms = tokenizeQuery(request.query);
    if (terms.length === 0 || request.candidates.length === 0) {
      return { results: [], unavailableScopes: [] };
    }

    const results: ThreadSearchResult[] = [];
    const unavailableScopes: ThreadSearchUnavailableScope[] = [];
    const candidates = request.candidates.slice(0, MAX_TRANSCRIPT_CANDIDATES);

    for (const candidate of candidates) {
      if (results.length >= request.limit) {
        break;
      }
      try {
        const response = await this.readThread({
          backend: candidate.backend,
          threadId: candidate.threadId,
          limit: DEFAULT_TRANSCRIPT_READ_LIMIT,
        });
        const snippet = findTranscriptSnippet(response, terms);
        if (!snippet) {
          continue;
        }
        results.push({
          ...candidate,
          score: candidate.score + 25,
          confidence: candidate.confidence === "high" ? "high" : "medium",
          matchReasons: [
            ...candidate.matchReasons,
            { kind: "provider_content_match", field: snippet.field, weight: 25 },
          ],
          snippets: [
            ...candidate.snippets,
            {
              scope: "provider_content",
              field: snippet.field,
              text: snippet.text,
              truncated: snippet.truncated,
              ...(snippet.turnId ? { turnId: snippet.turnId } : {}),
            },
          ],
        });
      } catch (error) {
        unavailableScopes.push({
          scope: "provider_content",
          backend: candidate.backend,
          reason: "error",
          message:
            error instanceof Error
              ? error.message
              : "Provider transcript search failed.",
        });
      }
    }

    return { results, unavailableScopes };
  }
}

function findTranscriptSnippet(
  response: AppServerReadThreadResponse,
  terms: string[],
): { field: string; text: string; truncated?: boolean; turnId?: string } | undefined {
  for (const message of response.replay.messages) {
    const text = message.text.trim();
    if (text && textMatchesTerms(text, terms)) {
      return {
        field: `message:${message.role}`,
        // Plain messages carry no turn; recover it from the matching entry so
        // the desktop can deep-link the result to the turn's `data-turn-id`.
        turnId: turnIdForMessage(response, message.id),
        ...buildSnippet(text, terms[0] ?? ""),
      };
    }
  }

  for (const entry of response.replay.entries) {
    if (entry.type !== "activity") {
      continue;
    }
    const texts = [
      entry.summary,
      ...entry.details.flatMap((detail) => [
        detail.label,
        detail.markdown,
        detail.command?.displayCommand,
        detail.command?.output,
      ]),
    ].filter((value): value is string => Boolean(value?.trim()));
    for (const text of texts) {
      if (textMatchesTerms(text, terms)) {
        return {
          field: "activity",
          turnId: entry.turn?.id,
          ...buildSnippet(text, terms[0] ?? ""),
        };
      }
    }
  }

  return undefined;
}

function turnIdForMessage(
  response: AppServerReadThreadResponse,
  messageId: string,
): string | undefined {
  for (const entry of response.replay.entries) {
    if (entry.type === "message" && entry.id === messageId) {
      return entry.turn?.id;
    }
  }
  return undefined;
}

function tokenizeQuery(query: string): string[] {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length > 1))].slice(0, 8);
}

function textMatchesTerms(text: string, terms: string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.every((term) => normalized.includes(term));
}

function buildSnippet(
  text: string,
  firstTerm: string,
): { text: string; truncated?: boolean } {
  const normalized = text.toLowerCase();
  const index = firstTerm ? normalized.indexOf(firstTerm) : -1;
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, (index >= 0 ? index : 0) + 220);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return {
    text: `${prefix}${text.slice(start, end).trim()}${suffix}`,
    truncated: start > 0 || end < text.length,
  };
}
