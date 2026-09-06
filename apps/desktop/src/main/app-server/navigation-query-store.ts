import { createHash, randomUUID } from "node:crypto";
import type {
  NavigationQueryPage,
  NavigationQueryRequest,
} from "@pwragent/shared";
import {
  NAVIGATION_QUERY_MAX_PAGE_ROWS,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  NAVIGATION_QUERY_PROTOCOL_VERSION,
} from "@pwragent/shared";
import {
  navigationQueryKey,
  projectNavigationQuery,
  type NavigationQueryIndex,
  type NavigationQueryMaterialization,
} from "./navigation-query-projection";
import {
  navigationAttentionOrderBytes,
  reconcileNavigationAttentionOrder,
  type NavigationAttentionOrder,
} from "./navigation-attention-order";

const NAVIGATION_QUERY_CURSOR_IDLE_MS = 60_000;
const NAVIGATION_QUERY_MAX_GENERATIONS = 8;
const NAVIGATION_QUERY_MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const NAVIGATION_ATTENTION_MAX_VIEWS = 64;
const NAVIGATION_ATTENTION_MAX_BYTES = 8 * 1024 * 1024;

export type NavigationQueryErrorCode =
  | "navigation_busy"
  | "navigation_cursor_expired"
  | "navigation_invalid_request"
  | "navigation_item_too_large";

export class NavigationQueryError extends Error {
  readonly code: NavigationQueryErrorCode;

  constructor(code: NavigationQueryErrorCode, message: string) {
    super(message);
    this.name = "NavigationQueryError";
    this.code = code;
  }
}

type NavigationQueryGeneration = {
  completeRevision: string;
  createdAt: number;
  generation: string;
  lastAccessedAt: number;
  materialization: NavigationQueryMaterialization;
  retainedBytes: number;
  scopeKey: string;
};

type NavigationQueryCursor = {
  generation: string;
  offset: number;
  queryKey: string;
  scopeKey: string;
};

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function encodeCursor(cursor: NavigationQueryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): NavigationQueryCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<NavigationQueryCursor>;
    if (
      typeof parsed.generation !== "string"
      || typeof parsed.offset !== "number"
      || !Number.isSafeInteger(parsed.offset)
      || parsed.offset < 0
      || typeof parsed.queryKey !== "string"
      || typeof parsed.scopeKey !== "string"
    ) {
      throw new Error("invalid cursor fields");
    }
    return parsed as NavigationQueryCursor;
  } catch {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "Navigation cursor is malformed.",
    );
  }
}

function validateRequest(request: NavigationQueryRequest): void {
  if (!request || request.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      `Navigation query protocol ${NAVIGATION_QUERY_PROTOCOL_VERSION} is required.`,
    );
  }
  if (
    request.attentionView !== undefined
    && (typeof request.attentionView.id !== "string"
      || request.attentionView.id.length < 1
      || request.attentionView.id.length > 128
      || typeof request.attentionView.promoteOnTurnEnd !== "boolean")
  ) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "Navigation Attention requires a bounded view identity and promotion policy.",
    );
  }
  if (
    request.pageSize !== undefined
    && (!Number.isSafeInteger(request.pageSize)
      || request.pageSize < 1
      || request.pageSize > NAVIGATION_QUERY_MAX_PAGE_ROWS)
  ) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "Navigation page size must be between 1 and 100.",
    );
  }
  if (request.query.kind === "exact" && request.query.identities.length > 100) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "An exact navigation query accepts at most 100 identities.",
    );
  }
  if (
    request.query.kind === "directory"
    && (request.query.disclosedParentThreadKeys?.length ?? 0) > 100
  ) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "A directory navigation query accepts at most 100 disclosures.",
    );
  }
}

function completeRevision(materialization: NavigationQueryMaterialization): string {
  return createHash("sha256")
    .update(JSON.stringify(materialization))
    .digest("base64url");
}

function pageBase(params: {
  generation: NavigationQueryGeneration;
  ownerEpoch: string;
}): Omit<NavigationQueryPage, "complete" | "entries"> {
  const { generation } = params;
  return {
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
    queryKey: generation.materialization.queryKey,
    generation: generation.generation,
    ownerEpoch: params.ownerEpoch,
    countsRevision: generation.completeRevision,
    coverage: { state: "complete" },
    counts: generation.materialization.counts,
  };
}

export class NavigationQueryStore {
  private readonly ownerEpoch = randomUUID();
  private readonly generations = new Map<string, NavigationQueryGeneration>();
  private readonly currentGenerationByScopeAndQuery = new Map<string, string>();
  private readonly attentionViews = new Map<string, {
    order: NavigationAttentionOrder;
    bytes: number;
  }>();

  constructor(
    private readonly options: {
      now?: () => number;
    } = {},
  ) {}

  async readPage(params: {
    loadIndex: () => Promise<NavigationQueryIndex>;
    request: NavigationQueryRequest;
    scopeKey: string;
  }): Promise<NavigationQueryPage> {
    validateRequest(params.request);
    const now = this.options.now?.() ?? Date.now();
    this.expireIdle(now);
    const queryKey = navigationQueryKey(params.request);
    let generation: NavigationQueryGeneration;
    let offset = 0;

    if (params.request.cursor) {
      const cursor = decodeCursor(params.request.cursor);
      if (cursor.scopeKey !== params.scopeKey || cursor.queryKey !== queryKey) {
        throw new NavigationQueryError(
          "navigation_invalid_request",
          "Navigation cursor does not belong to this requester and query.",
        );
      }
      const retained = this.generations.get(cursor.generation);
      if (!retained) {
        throw new NavigationQueryError(
          "navigation_cursor_expired",
          "Navigation cursor expired; rebaseline around the visible anchor.",
        );
      }
      generation = retained;
      offset = cursor.offset;
    } else {
      const index = await params.loadIndex();
      const attentionOrder = this.reconcileAttentionView(params.scopeKey, params.request, index);
      const materialization = projectNavigationQuery({
        index,
        request: params.request,
        attentionOrder,
      });
      const revision = completeRevision(materialization);
      const currentKey = `${params.scopeKey}\u0000${queryKey}`;
      const currentId = this.currentGenerationByScopeAndQuery.get(currentKey);
      const current = currentId ? this.generations.get(currentId) : undefined;
      if (current?.completeRevision === revision) {
        generation = current;
      } else {
        generation = this.retainGeneration({
          completeRevision: revision,
          createdAt: now,
          generation: randomUUID(),
          lastAccessedAt: now,
          materialization,
          retainedBytes: serializedBytes(materialization),
          scopeKey: params.scopeKey,
        });
        this.currentGenerationByScopeAndQuery.set(currentKey, generation.generation);
      }
      if (
        params.request.completeBaselineRevision
        && params.request.completeBaselineRevision === generation.completeRevision
      ) {
        const unchanged: NavigationQueryPage = {
          ...pageBase({ generation, ownerEpoch: this.ownerEpoch }),
          entries: [],
          directories: [],
          complete: true,
          unchanged: true,
        };
        this.assertPageBudget(unchanged);
        generation.lastAccessedAt = now;
        return unchanged;
      }
    }

    generation.lastAccessedAt = now;
    return this.buildPage({
      generation,
      offset,
      ownerEpoch: this.ownerEpoch,
      pageSize: params.request.pageSize ?? NAVIGATION_QUERY_MAX_PAGE_ROWS,
    });
  }

  /** Window teardown releases order lifetime; page expiry deliberately does not. */
  releaseAttentionView(scopeKey: string, viewId: string): void {
    for (const promoteOnTurnEnd of [false, true]) {
      this.attentionViews.delete(JSON.stringify([scopeKey, viewId, promoteOnTurnEnd]));
    }
  }

  private reconcileAttentionView(
    scopeKey: string,
    request: NavigationQueryRequest,
    index: NavigationQueryIndex,
  ): NavigationAttentionOrder | undefined {
    if (!request.attentionView) return undefined;
    const { id, promoteOnTurnEnd } = request.attentionView;
    const key = JSON.stringify([scopeKey, id, promoteOnTurnEnd]);
    const previous = this.attentionViews.get(key);
    if (!previous && this.attentionViews.size >= NAVIGATION_ATTENTION_MAX_VIEWS) {
      throw new NavigationQueryError("navigation_busy", "Attention view budget is occupied.");
    }
    const order = reconcileNavigationAttentionOrder({
      previous: previous?.order,
      threads: index.threads,
      promoteOnTurnEnd,
    });
    const bytes = navigationAttentionOrderBytes(order);
    let retainedBytes = bytes;
    for (const [otherKey, view] of this.attentionViews) {
      if (otherKey !== key) retainedBytes += view.bytes;
    }
    if (retainedBytes > NAVIGATION_ATTENTION_MAX_BYTES) {
      throw new NavigationQueryError("navigation_busy", "Attention metadata exceeds its retained budget.");
    }
    this.attentionViews.set(key, { order, bytes });
    return order;
  }

  private buildPage(params: {
    generation: NavigationQueryGeneration;
    offset: number;
    ownerEpoch: string;
    pageSize: number;
  }): NavigationQueryPage {
    const collection = params.generation.materialization.directories.length > 0
      ? params.generation.materialization.directories
      : params.generation.materialization.entries;
    if (params.offset > collection.length) {
      throw new NavigationQueryError(
        "navigation_invalid_request",
        "Navigation cursor offset is outside its generation.",
      );
    }
    const page: NavigationQueryPage = {
      ...pageBase({
        generation: params.generation,
        ownerEpoch: params.ownerEpoch,
      }),
      entries: [],
      ...(params.generation.materialization.directories.length > 0
        ? { directories: [] }
        : {}),
      complete: false,
    };
    let nextOffset = params.offset;
    for (
      ; nextOffset < collection.length
        && nextOffset - params.offset < params.pageSize;
      nextOffset += 1
    ) {
      const item = collection[nextOffset]!;
      const candidate = params.generation.materialization.directories.length > 0
        ? {
            ...page,
            directories: [...(page.directories ?? []), item],
          }
        : {
            ...page,
            entries: [...page.entries, item],
          };
      if (serializedBytes(candidate) > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
        if (nextOffset === params.offset) {
          throw new NavigationQueryError(
            "navigation_item_too_large",
            "One navigation row exceeds the result budget; read its exact detail.",
          );
        }
        break;
      }
      if (params.generation.materialization.directories.length > 0) {
        page.directories!.push(item as NonNullable<NavigationQueryPage["directories"]>[number]);
      } else {
        page.entries.push(item as NavigationQueryPage["entries"][number]);
      }
    }
    page.complete = nextOffset >= collection.length;
    if (!page.complete) {
      page.nextCursor = encodeCursor({
        generation: params.generation.generation,
        offset: nextOffset,
        queryKey: params.generation.materialization.queryKey,
        scopeKey: params.generation.scopeKey,
      });
      this.assertPageBudget(page);
    }
    return page;
  }

  private retainGeneration(
    generation: NavigationQueryGeneration,
  ): NavigationQueryGeneration {
    if (generation.retainedBytes > NAVIGATION_QUERY_MAX_RETAINED_BYTES) {
      throw new NavigationQueryError(
        "navigation_busy",
        "Navigation query exceeds the process retained-memory budget.",
      );
    }
    const retainedBytes = [...this.generations.values()]
      .reduce((total, item) => total + item.retainedBytes, 0);
    if (
      this.generations.size >= NAVIGATION_QUERY_MAX_GENERATIONS
      || retainedBytes + generation.retainedBytes > NAVIGATION_QUERY_MAX_RETAINED_BYTES
    ) {
      throw new NavigationQueryError(
        "navigation_busy",
        "Navigation query pool is busy; retry after an inactive reader releases.",
      );
    }
    this.generations.set(generation.generation, generation);
    return generation;
  }

  private expireIdle(now: number): void {
    for (const generation of this.generations.values()) {
      if (now - generation.lastAccessedAt <= NAVIGATION_QUERY_CURSOR_IDLE_MS) {
        continue;
      }
      this.generations.delete(generation.generation);
    }
    for (const [key, generationId] of this.currentGenerationByScopeAndQuery) {
      if (!this.generations.has(generationId)) {
        this.currentGenerationByScopeAndQuery.delete(key);
      }
    }
  }

  private assertPageBudget(page: NavigationQueryPage): void {
    if (serializedBytes(page) > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
      throw new NavigationQueryError(
        "navigation_item_too_large",
        "Navigation response exceeds the result budget.",
      );
    }
  }
}

const desktopNavigationQueryStore = new NavigationQueryStore();

export function getDesktopNavigationQueryStore(): NavigationQueryStore {
  return desktopNavigationQueryStore;
}
