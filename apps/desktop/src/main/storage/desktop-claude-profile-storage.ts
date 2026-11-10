import type { ClaudeProfileSessionMetadata, ClaudeSessionMetadataStorage } from "@pwragent/owner-core/claude-profile-storage";
import { ClaudeSessionMetadataStore } from "./claude-session-metadata-store";

export function createClaudeSessionMetadataStorage<T extends ClaudeProfileSessionMetadata>(root: string): ClaudeSessionMetadataStorage<T> {
  return new ClaudeSessionMetadataStore<T>(root);
}
