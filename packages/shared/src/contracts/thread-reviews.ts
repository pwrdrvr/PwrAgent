import type { FederationRemoteTarget } from "./federation";
import type {
  AppServerBackendKind,
  AppServerReviewContext,
  AppServerReviewFinding,
} from "./normalized-app-server";
import { classifyDirectory } from "../directory-navigation";
import type { ThreadTodo, ThreadTodoProject } from "./thread-todos";

export const PWRAGENT_THREAD_REVIEW_OPERATION_NAMES = [
  "record_review", "list_reviews", "update_review_item", "update_review",
] as const;

export type ThreadReviewStatus = "open" | "handled" | "dismissed";
/**
 * Where one finding stands. Each name says what was done: `addressed` (fixed,
 * with a note on what changed), `declined` (will not be fixed, with the
 * reason), or `deferred` (left for later, with the to-do card that tracks it).
 * See "Finding outcomes" in docs/thread-reviews.md.
 */
export type ThreadReviewItemStatus = "open" | "addressed" | "declined" | "deferred";
export const THREAD_REVIEW_ITEM_STATUSES: readonly ThreadReviewItemStatus[] = ["open", "addressed", "declined", "deferred"];
/**
 * Other names a finding update accepts. Records and peers written before
 * `declined` store `dismissed`. Claude Code's code review reports `fixed`,
 * `no_change_needed`, and `skipped` ("real but not applied"); it treats all
 * three as settled, so PwrAgent does too.
 */
export const THREAD_REVIEW_ITEM_STATUS_ALIASES: Readonly<Record<string, ThreadReviewItemStatus>> = {
  dismissed: "declined",
  fixed: "addressed",
  no_change_needed: "declined",
  skipped: "declined",
};
export type ThreadReviewIdentity = { backend: AppServerBackendKind; threadId: string; federationTarget?: FederationRemoteTarget };

export type ThreadReviewResolution = {
  note: string;
  /** A commit, PR comment, dismissal discussion, or other supporting URL. */
  url?: string;
  /** The to-do card a deferred finding waits on, as it was titled then. */
  todo?: { id: string; title: string };
  actor: "agent" | "user" | "system";
  at: number;
};

export type ThreadReviewItem = {
  id: string;
  title: string;
  body?: string;
  priority?: number;
  category?: AppServerReviewFinding["category"];
  codeLocation?: AppServerReviewFinding["code_location"];
  status: ThreadReviewItemStatus;
  createdAt: number;
  updatedAt: number;
  resolution?: ThreadReviewResolution;
};

export type ThreadReview = ThreadReviewIdentity & {
  id: string;
  /** Absent on records written before import provenance was tracked. */
  origin?: "automatic" | "explicit";
  /** Stable artifact id or external review URL/key; scoped to this thread. */
  sourceKey: string;
  sourceUrl?: string;
  title: string;
  summary?: string;
  context?: AppServerReviewContext;
  status: ThreadReviewStatus;
  items: ThreadReviewItem[];
  createdAt: number;
  updatedAt: number;
  resolution?: ThreadReviewResolution;
};

export type RecordThreadReviewInput = Pick<ThreadReview, "sourceKey" | "sourceUrl" | "title" | "summary" | "context"> & {
  items: Array<Pick<ThreadReviewItem, "title" | "body" | "priority" | "category" | "codeLocation">>;
  /** Only a structured review with no findings is automatically handled. */
  clean?: boolean;
  createdAt?: number;
};

export type UpdateThreadReviewRequest = {
  federationTarget?: FederationRemoteTarget;
  id: string;
  itemId?: string;
  /** A finding also accepts a name in `THREAD_REVIEW_ITEM_STATUS_ALIASES`. */
  status: ThreadReviewStatus | ThreadReviewItemStatus;
  note?: string;
  url?: string;
  /** Required to defer a finding: the id of the to-do card that tracks it. */
  todoId?: string;
};

export type ListThreadReviewsRequest = Partial<ThreadReviewIdentity> & {
  status?: ThreadReviewStatus | "all";
};

/** A finding status by its current name, or undefined when it names none. */
export function normalizeThreadReviewItemStatus(value: unknown): ThreadReviewItemStatus | undefined {
  if (typeof value !== "string") return undefined;
  if ((THREAD_REVIEW_ITEM_STATUSES as readonly string[]).includes(value)) return value as ThreadReviewItemStatus;
  return Object.hasOwn(THREAD_REVIEW_ITEM_STATUS_ALIASES, value) ? THREAD_REVIEW_ITEM_STATUS_ALIASES[value] : undefined;
}

/**
 * A review with each finding under its current status name. A record from an
 * older build, or from a peer that runs one, can still say `dismissed`.
 * Returns the same object when nothing needed renaming.
 */
export function normalizeThreadReview<T extends Pick<ThreadReview, "items">>(review: T): T {
  if (review.items.every((item) => (THREAD_REVIEW_ITEM_STATUSES as readonly string[]).includes(item.status))) return review;
  return {
    ...review,
    items: review.items.map((item) => {
      const status = normalizeThreadReviewItemStatus(item.status);
      return status && status !== item.status ? { ...item, status } : item;
    }),
  };
}

/**
 * What a review card is called. Stored titles are generic ("Code review"), so
 * the reviewed pull request or branch names it when the context recorded one;
 * deriving it here leaves existing records as they are.
 */
export function threadReviewDisplayTitle(review: Pick<ThreadReview, "title" | "context">): string {
  // An agent's own title for a recorded review says more than either.
  if (review.title !== "Code review") return review.title;
  const pullRequest = review.context?.pullRequest;
  if (pullRequest) return `Review of PR #${pullRequest.number}`;
  const branch = review.context?.gitBranch;
  return branch ? `Review of ${branch}` : review.title;
}

/** Review cards share scope, counts, seen markers, and sorting with to-dos. */
export function threadReviewTodo(review: ThreadReview): ThreadTodo {
  const remaining = review.items.filter((item) => item.status === "open").length;
  const projectPath = review.context?.repositoryPath ?? review.context?.workspacePath;
  return {
    id: `review:${review.id}`,
    reviewId: review.id,
    backend: review.backend,
    threadId: review.threadId,
    kind: "review",
    status: review.status === "handled" ? "done" : review.status,
    title: threadReviewDisplayTitle(review),
    detail: review.status === "open"
      ? `${remaining} open ${remaining === 1 ? "finding" : "findings"}${review.summary ? ` · ${review.summary}` : ""}`
      : review.resolution?.note,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    ...(review.status === "open" ? {} : { resolvedAt: review.updatedAt }),
    ...(projectPath ? { sourceProject: reviewProject(projectPath, review.context?.projectLabel) } : {}),
  };
}

/**
 * Keyed the way every other card's project is, so a review lands in the
 * Project lens of the thread it belongs to: canonical separators, a scratch
 * workspace under its `workspace:` root.
 */
function reviewProject(path: string, label: string | undefined): ThreadTodoProject {
  const descriptor = classifyDirectory({ id: path, label: label ?? path, path, kind: "local" });
  return {
    key: descriptor.key,
    path: descriptor.path ?? path,
    label: label ?? descriptor.label,
  };
}
