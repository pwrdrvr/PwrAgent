import { SqliteFactoryLandingStore } from "@pwragent/sqlite-storage/factory-landing-store";
import { SqliteFactoryBranchReviewStore } from "@pwragent/sqlite-storage/factory-branch-review-store";
import { SqliteFactoryAdmissionStore } from "@pwragent/sqlite-storage/factory-admission-store";
import { SqliteFactoryPublicationStore } from "@pwragent/sqlite-storage/factory-publication-store";
import { getAppStateDb } from "../state/app-state";
export type { FactoryPublicationRow } from "@pwragent/sqlite-storage/factory-publication-store";

export function createFactoryAdmissionStorage(): SqliteFactoryAdmissionStore {
  return new SqliteFactoryAdmissionStore(getAppStateDb());
}

export function createFactoryBranchReviewStorage(): SqliteFactoryBranchReviewStore {
  return new SqliteFactoryBranchReviewStore(getAppStateDb());
}

export function createFactoryPublicationStorage(): SqliteFactoryPublicationStore {
  return new SqliteFactoryPublicationStore(getAppStateDb());
}

export function createFactoryLandingStorage(): SqliteFactoryLandingStore {
  return new SqliteFactoryLandingStore(getAppStateDb());
}
