import type { ResearchEvent, ResearchRun, ResearchThread } from "@pwragent/shared/research";

export interface ResearchStorage {
  findByStartKey(key: string): ResearchRun | undefined;
  get(id: string): ResearchRun | undefined;
  list(thread?: ResearchThread): ResearchRun[];
  create(id: string, startKey: string, event: ResearchEvent): void;
  /** Compare-and-append atomically. A conflicting duplicate command is refused. */
  append(id: string, revision: number, event: ResearchEvent): void;
}
