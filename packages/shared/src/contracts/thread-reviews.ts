import type {
  AppServerBackendKind,
  AppServerReviewContext,
  AppServerReviewFinding,
} from "./normalized-app-server";
import type { ThreadTodo } from "./thread-todos";

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
    title: review.title,
    detail: review.status === "open"
      ? `${remaining} open ${remaining === 1 ? "finding" : "findings"}${review.summary ? ` · ${review.summary}` : ""}`
      : review.resolution?.note,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    ...(review.status === "open" ? {} : { resolvedAt: review.updatedAt }),
    ...(projectPath ? { sourceProject: {
      key: `directory:${projectPath}`,
      path: projectPath,
      label: review.context?.projectLabel ?? projectPath.split(/[\\/]/).pop() ?? projectPath,
    } } : {}),
  };
}
