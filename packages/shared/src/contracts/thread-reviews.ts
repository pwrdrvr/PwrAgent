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
export type ThreadReviewItemStatus = "open" | "addressed" | "dismissed";
export type ThreadReviewIdentity = { backend: AppServerBackendKind; threadId: string };

export type ThreadReviewResolution = {
  note: string;
  /** A commit, PR comment, dismissal discussion, or other supporting URL. */
  url?: string;
  actor: "agent" | "user" | "system";
  at: number;
};

export type ThreadReviewItem = {
  id: string;
  title: string;
  body?: string;
  priority?: number;
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
  items: Array<Pick<ThreadReviewItem, "title" | "body" | "priority" | "codeLocation">>;
  /** Only a structured review with no findings is automatically handled. */
  clean?: boolean;
  createdAt?: number;
};

export type UpdateThreadReviewRequest = {
  id: string;
  itemId?: string;
  status: ThreadReviewStatus | ThreadReviewItemStatus;
  note?: string;
  url?: string;
};

export type ListThreadReviewsRequest = Partial<ThreadReviewIdentity> & {
  status?: ThreadReviewStatus | "all";
};

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
