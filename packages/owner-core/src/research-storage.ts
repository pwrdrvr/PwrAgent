import type { ResearchEvent, ResearchRun, ResearchThread, ResearchRunHeader, ResearchItem, ResearchSearchQuery, ResearchSearchPage, ResearchRunSummary, ResearchEventRange, ResearchEventPage } from "@pwragent/shared/research";

export interface ResearchStorage {
  findByStartKey(key: string): ResearchRun | undefined;
  get(id: string): ResearchRun | undefined;
  list(thread?: ResearchThread): ResearchRun[];
  header(id: string): ResearchRunHeader | undefined;
  summaries(thread: ResearchThread): ResearchRunHeader[];
  /** The thread's newest runs, without replaying any journal. */
  runSummaries(thread: ResearchThread, limit: number): ResearchRunSummary[];
  /** One page of the journal and its revision, read from one snapshot. */
  events(id: string, range: ResearchEventRange): ResearchEventPage;
  members(id: string): ResearchThread[];
  isMember(id: string, thread: ResearchThread): boolean;
  readItem(id: string, itemId: string): ResearchItem | undefined;
  search(id: string, query: ResearchSearchQuery): ResearchSearchPage;
  findCommand(id: string, commandId: string): ResearchEvent | undefined;
  create(id: string, startKey: string, event: ResearchEvent): void;
  /** Compare-and-append atomically. A conflicting duplicate command is refused. */
  append(id: string, revision: number, event: ResearchEvent): void;
}
