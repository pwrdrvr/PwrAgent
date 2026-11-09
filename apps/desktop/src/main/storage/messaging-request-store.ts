import type Database from "better-sqlite3";
import type { MessagingInboundEvent } from "@pwragent/messaging-interface";
import { SqliteMessagingRequestStore as SharedStore } from "@pwragent/sqlite-storage/messaging-request-store";
import { projectMessagingRequest } from "../messaging/core/messaging-request-projection";

// The original factory binds the shared implementation to this host's policy.
export class SqliteMessagingRequestStore extends SharedStore<MessagingInboundEvent> {
  constructor(db: Database.Database) {
    super(db, projectMessagingRequest);
  }
}
