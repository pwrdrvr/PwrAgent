import { SqliteFactoryBranchReviewStore } from "@pwragent/sqlite-storage/factory-branch-review-store";
import { SqliteFactoryAdmissionStore } from "@pwragent/sqlite-storage/factory-admission-store";
import { getAppStateDb } from "../state/app-state";

export function createFactoryAdmissionStorage(): SqliteFactoryAdmissionStore {
  return new SqliteFactoryAdmissionStore(getAppStateDb());
}

export function createFactoryBranchReviewStorage(): SqliteFactoryBranchReviewStore {
  return new SqliteFactoryBranchReviewStore(getAppStateDb());
}
