import type { ThreadTodosChangedEvent } from "@pwragent/shared";
import { getAppStateDb } from "../state/app-state";
import { ThreadReviewService } from "./thread-review-service";

let service: ThreadReviewService | undefined;
let broadcast: ((event: ThreadTodosChangedEvent) => void) | undefined;

export function getThreadReviewService(): ThreadReviewService {
  return service ??= new ThreadReviewService(getAppStateDb(), (event) => broadcast?.(event));
}

export function setThreadReviewBroadcast(listener: (event: ThreadTodosChangedEvent) => void): void {
  broadcast = listener;
}

export function resetThreadReviewServiceForTests(): void {
  service = undefined;
  broadcast = undefined;
}
