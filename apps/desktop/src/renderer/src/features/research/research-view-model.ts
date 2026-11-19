import { researchApproachOccupiesSlot, researchHarnessEffectiveState, researchRunStoreSynced, sameResearchThread, type ResearchApproach, type ResearchEvent, type ResearchEventPage, type ResearchFinding, type ResearchItem, type ResearchRun, type ResearchRunHeader, type ResearchRunState, type ResearchRunStore, type ResearchRunSummary, type ResearchHarnessState, type ResearchSearchHit, type ResearchSearchPage, type ResearchSearchQuery, type ResearchSubmission } from "@pwragent/shared";

/**
 * One run as the panel draws it: its header, its current state and counts,
 * and the window's store of its items. Lists that can grow without bound,
 * the findings and each approach's contributions, are not held here in
 * order: the Findings view pages them, and the Map reads `leaves`.
 */
export type ResearchRunView = ResearchRunHeader & ResearchRunState & Pick<ResearchRunStore, "items" | "approaches" | "submissions" | "leaves">;

/** The view of a run whose store has finished a sync, or undefined while its first sync is in flight. */
export function researchRunView(header: Omit<ResearchRunHeader, "harness"> & { harness?: unknown }, store: ResearchRunStore): ResearchRunView | undefined {
  if (store.runId !== header.id || !store.state || !researchRunStoreSynced(store)) return undefined;
  // A summary names only the Harness phase; the run's full source state arrives with its store.
  const { harness: _phase, ...run } = header;
  return { ...run, ...store.state, items: store.items, approaches: store.approaches, submissions: store.submissions, leaves: store.leaves };
}

export type ResearchTone = "live" | "attention" | "done" | "neutral" | "problem";
export type ResearchPhase = { label: string; tone: ResearchTone };

export function researchLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (s) => s.toUpperCase());
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function isResearchRunLive(run: Pick<ResearchRun, "status">): boolean {
  return run.status === "running" || run.status === "stopping";
}

export function unreviewedCandidates(run: Pick<ResearchRun, "submissions">): ResearchSubmission[] {
  return run.submissions.filter((submission) => !submission.review);
}

/** What names a run's phase. A summary and a run view both carry it. */
export type ResearchPhaseInput = Pick<ResearchRunSummary, "status" | "activeWorkers" | "unreviewed" | "accepted"> & {
  harness?: Pick<ResearchHarnessState, "state" | "mode" | "source">;
};

/**
 * The operator-facing phase. A running run with no worker holding a slot is
 * waiting on the coordinator: "Awaiting review" while any candidate is
 * undecided, "Ready to finish" once one is accepted and none is undecided.
 * An approach with an unresolved revision delivery still holds its slot.
 */
export function researchRunPhase(run: ResearchPhaseInput): ResearchPhase {
  if (run.harness) return researchHarnessPhase(run, run.harness);
  if (run.status === "running") {
    if (run.activeWorkers > 0) return { label: "Running", tone: "live" };
    if (run.unreviewed) return { label: "Awaiting review", tone: "attention" };
    if (run.accepted) return { label: "Ready to finish", tone: "attention" };
    return { label: "Running", tone: "live" };
  }
  switch (run.status) {
    case "stopping": return { label: "Stopping", tone: "live" };
    case "completed": return { label: "Completed", tone: "done" };
    case "deadline": return { label: "Deadline reached", tone: "neutral" };
    case "stopped": return { label: "Stopped", tone: "neutral" };
    case "exhausted": return { label: "No candidates", tone: "neutral" };
    case "interrupted": return { label: "Interrupted", tone: "problem" };
  }
}

/**
 * A Harness run's chip follows the owner's Harness state. The native status the
 * owner stores to retire a run (interrupted, stopping) does not say what the
 * source did: a complete import is not a failure, an unacknowledged stop is
 * not a stop, and an unknown outcome stays visible until reconciled.
 */
function researchHarnessPhase(run: Omit<ResearchPhaseInput, "harness">, harness: NonNullable<ResearchPhaseInput["harness"]>): ResearchPhase {
  if (run.status === "completed") return { label: "Completed", tone: "done" };
  // A run its dead owner left pending or running is not running: its outcome is unknown.
  switch (researchHarnessEffectiveState(run.status, harness)) {
    case "unknown": return { label: "Outcome unknown", tone: "attention" };
    case "reconciling": return { label: "Reconciling", tone: "live" };
    case "stopping": return run.status === "stopping" ? { label: "Stopping", tone: "live" } : { label: "Stop unconfirmed", tone: "attention" };
    case "imported": return { label: harness.source === "discovery" ? "Snapshot" : "Imported", tone: "neutral" };
    case "stopped": return { label: "Stopped", tone: "neutral" };
    case "ended": return run.unreviewed ? { label: "Awaiting review", tone: "attention" } : { label: "Source ended", tone: "neutral" };
    case "pending": return { label: "Starting", tone: "live" };
    case "running":
      if (harness.mode === "import") return { label: "Observing", tone: "live" };
      return run.unreviewed ? { label: "Awaiting review", tone: "attention" } : { label: "Running", tone: "live" };
  }
}

/** When a Harness run was observed or started; an import or snapshot has no deadline of its own. */
export function researchHarnessTime(run: Pick<ResearchRunView, "status" | "deadlineAt" | "createdAt" | "harness">, now: number): string {
  const harness = run.harness!;
  if (harness.mode === "import") return harness.observedAt ? `Observed ${formatClock(harness.observedAt)}` : `Requested ${formatClock(run.createdAt)}`;
  if (isResearchRunLive(run) && harness.state !== "unknown") return researchTimeLeft(run, now);
  return `Started ${formatClock(run.createdAt)} · ${Math.round((run.deadlineAt - run.createdAt) / 60_000)} min limit`;
}

/** The unresolved-outcome callout for a Harness run, or undefined when its source outcome is settled. */
export function researchHarnessOutcome(run: Pick<ResearchRunView, "status" | "harness">): { title: string; body: string } | undefined {
  const harness = run.harness;
  if (!harness || run.status === "completed") return undefined;
  const unresolvedStop = harness.state === "stopping" && run.status !== "stopping";
  const ownerLost = harness.state !== "unknown" && researchHarnessEffectiveState(run.status, harness) === "unknown";
  if (harness.state !== "unknown" && !unresolvedStop) {
    // The owner ended while this run was pending or running, so its last note describes work nobody is doing.
    if (!ownerLost) return undefined;
    return harness.mode === "import"
      ? { title: "This import ended before it was complete.", body: "PwrAgent closed while it was reading the source. Source work was never owned by this import." }
      : { title: "This run's outcome is unknown.", body: "PwrAgent closed while this swarm was running. Source work may still be running. PwrAgent will not resend the start or the stop." };
  }
  // Stopping an import sends no cancellation, so only an execution can have an unconfirmed stop.
  const title = harness.mode === "import" ? "This import ended before it was complete."
    : unresolvedStop || harness.unresolved === "cancel" || run.status === "stopping" ? "The bridge did not confirm the stop." : "This run's outcome is unknown.";
  const tail = harness.mode === "import" ? "Source work was never owned by this import." : "PwrAgent will not resend the start or the stop.";
  return { title, body: `${harness.note} ${tail}` };
}

/** Remaining time for a live run, or when its deadline fell for a finished one. */
export function researchTimeLeft(run: Pick<ResearchRun, "status" | "deadlineAt">, now: number): string {
  const at = formatClock(run.deadlineAt);
  if (!isResearchRunLive(run)) return `Deadline ${at}`;
  const remaining = run.deadlineAt - now;
  if (remaining <= 0) return "Deadline passed";
  if (remaining < 60_000) return `Under a minute left · ends ${at}`;
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 60) return `${minutes} min left · ends ${at}`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left · ends ${at}`;
}

/** When a run in a list happened: the time today, otherwise the date. */
export function formatRunWhen(at: number, now: number): string {
  const then = new Date(at), today = new Date(now);
  const sameDay = then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate();
  return sameDay ? formatClock(at) : then.toLocaleDateString([], { month: "short", day: "numeric", ...(then.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function researchRunCounts(run: Pick<ResearchRunView, "activeWorkers" | "workerLimit" | "findings" | "candidates" | "unreviewed" | "accepted">) {
  return { slotsInUse: run.activeWorkers, workerLimit: run.workerLimit, findings: run.findings, candidates: run.candidates, unreviewed: run.unreviewed, accepted: run.accepted };
}

/** Why Finish is unavailable, or undefined when it is. */
export function researchFinishBlocker(run: Pick<ResearchRunView, "accepted">): string | undefined {
  if (!run.accepted) return "Accept a candidate to finish the run.";
  return undefined;
}

/** The approach with this ID, or undefined when the run has none. */
export function researchApproach(run: Pick<ResearchRunView, "items">, id: string): ResearchApproach | undefined {
  const item = run.items.get(id);
  return item?.type === "approach" ? item.record : undefined;
}

/** Why a revision cannot be requested for this candidate, or undefined when it can. */
export function researchRevisionBlocker(run: Pick<ResearchRunView, "status" | "items" | "activeWorkers" | "workerLimit" | "harness">, submission: ResearchSubmission, live: boolean): string | undefined {
  if (run.harness) return "Revision feedback requires the source service.";
  if (!live || run.status !== "running") return "Revisions need a running run.";
  const approach = researchApproach(run, submission.approachId);
  if (!approach?.worker) return "This candidate's worker is unavailable.";
  if (approach.revisionDeliveryIds?.length) return "A revision is already pending for this worker.";
  if (!researchApproachOccupiesSlot(approach) && run.activeWorkers >= run.workerLimit) return "Every worker slot is in use.";
  return undefined;
}

export function approachTitle(run: Pick<ResearchRunView, "items">, id: string): string {
  return researchApproach(run, id)?.title ?? id;
}

export function researchSourceLabel(run: Pick<ResearchRunView, "items">, itemId: string): string {
  const source = run.items.get(itemId)?.provenance;
  return source ? `${source.member ?? "Source"} · #${source.seq}` : "Source provenance unavailable";
}

/** The full provenance a compact source label stands for, for its tooltip and accessible description. */
export function researchSourceDetail(run: Pick<ResearchRunView, "items">, itemId: string): string {
  const source = run.items.get(itemId)?.provenance;
  return source ? `Source member ${source.member ?? "service"}, record ${source.seq}, recorded ${formatClock(source.at)}. SHA-256 ${source.digest}` : "Source provenance unavailable";
}

/**
 * Who acted, in the operator's words. Only commands from the panel carry an
 * `operator:` key; other operator-authority events are the owner's own
 * lifecycle bookkeeping (deadline, settlement, recovery).
 */
export function researchActorLabel(run: Pick<ResearchRun, "approaches" | "coordinator">, actor: ResearchEvent["actor"], commandId = ""): string {
  if (actor.kind === "operator") return commandId.startsWith("operator:") ? "You" : "PwrAgent";
  if (sameResearchThread(actor, run.coordinator)) return "Coordinator";
  const approach = run.approaches.find((a) => a.worker && sameResearchThread(a.worker, actor));
  return approach ? approach.title : "Worker";
}

export function excerpt(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

export type ResearchActivityRow = { seq: number; at: number; kind: string; actor: string; text: string; itemId?: string };

/** One row per loaded event, newest first as given. Approach IDs are replaced with their titles. */
export function researchActivityRows(run: Pick<ResearchRunView, "items" | "approaches" | "coordinator">, events: readonly ResearchEvent[]): ResearchActivityRow[] {
  const title = (id: string) => approachTitle(run, id);
  const itemExcerpt = (itemId: string) => {
    const entry = run.items.get(itemId);
    return entry ? excerpt(researchItemText(entry), 80) : itemId;
  };
  const rows: ResearchActivityRow[] = [];
  for (const event of events) {
    const data = event.data;
    // Worker admission and delivery receipts are recorded by the owner, whoever triggered them.
    const system = data.type === "worker" || data.type === "delivery" || data.type === "delivery_failed" || data.type === "harness";
    const row = (kind: string, text: string, itemId?: string): ResearchActivityRow => ({ seq: event.seq, at: event.at, kind,
      actor: event.provenance ? `Source ${event.provenance.member ?? "service"}` : system ? "PwrAgent" : researchActorLabel(run, event.actor, event.commandId), text, ...(itemId ? { itemId } : {}) });
    switch (data.type) {
      case "created": rows.push(row("Run requested", data.objective)); break;
      case "worker": rows.push(row("Worker", `${title(data.approachId)}: ${researchLabel(data.state)}${data.note ? ` · ${data.note}` : ""}`, data.approachId)); break;
      case "finding": rows.push(row(researchLabel(data.finding.kind), data.finding.text, data.finding.id)); break;
      case "submission": rows.push(row("Candidate", data.submission.text, data.submission.id)); break;
      case "review": rows.push(row(researchLabel(data.decision), data.reason, data.submissionId)); break;
      case "abandoned": rows.push(row("Abandoned", `${title(data.approachId)}: ${data.reason}`, data.approachId)); break;
      case "direction": rows.push(row("Direction changed", `${data.title} · ${data.reason}`, data.approachId)); break;
      case "status": rows.push(row(researchRunPhase({ status: data.status, activeWorkers: 0, unreviewed: 0, accepted: 0 }).label, data.reason)); break;
      case "delivery_failed": rows.push(row("Delivery unconfirmed", data.reason)); break;
      case "delivery": rows.push(row("Revision feedback", `${data.delivery.approachId ? `${title(data.delivery.approachId)}: ` : ""}${researchLabel(data.delivery.state)}`, data.delivery.approachId)); break;
      case "assignment": rows.push(row("Child assigned", data.task, data.itemId)); break;
      case "item_work": rows.push(row(researchLabel(data.work.state), data.work.note ?? itemExcerpt(data.itemId), data.itemId)); break;
      case "harness": rows.push(row("Harness", data.state.note)); break;
      case "harness_observation": rows.push(row(`Harness ${data.event}`, data.text)); break;
    }
  }
  return rows;
}

/**
 * The loaded part of a run's journal: one contiguous stretch, newest first,
 * that ends at the newest event the window has read. `nextBeforeSeq` is set
 * while older events remain.
 */
export type ResearchActivityWindow = { runId: string; events: ResearchEvent[]; nextBeforeSeq?: number };

export function emptyResearchActivity(runId: string): ResearchActivityWindow {
  return { runId, events: [] };
}

/** The range that reads what was appended since the window's newest event. */
export function researchActivityHeadRange(window: ResearchActivityWindow, limit: number) {
  const top = window.events[0]?.seq;
  return top === undefined ? { limit } : { afterSeq: top, limit };
}

/**
 * Merge a head read (`researchActivityHeadRange`). New events go on top. If
 * more arrived than one page holds, the page leaves a gap above the old
 * window, so the window restarts from the page; Show older reaches the rest.
 */
export function mergeResearchActivityHead(window: ResearchActivityWindow, page: ResearchEventPage): ResearchActivityWindow {
  if (page.runId !== window.runId) return window;
  const top = window.events[0]?.seq ?? 0;
  const fresh = page.events.filter((event) => event.seq > top);
  if (!window.events.length || (fresh.length && page.nextBeforeSeq !== undefined && page.nextBeforeSeq > top + 1)) {
    return { runId: window.runId, events: page.events, ...(page.nextBeforeSeq !== undefined ? { nextBeforeSeq: page.nextBeforeSeq } : {}) };
  }
  if (!fresh.length) return window;
  return { ...window, events: [...fresh, ...window.events] };
}

/** Append an older page. A page that does not continue the window, such as one read before a restart, is ignored. */
export function appendResearchActivityOlder(window: ResearchActivityWindow, page: ResearchEventPage): ResearchActivityWindow {
  const oldest = window.events.at(-1);
  if (page.runId !== window.runId || !oldest || window.nextBeforeSeq !== oldest.seq || page.events[0]?.seq !== oldest.seq - 1) return window;
  const { nextBeforeSeq: _previous, ...rest } = window;
  return { ...rest, events: [...window.events, ...page.events], ...(page.nextBeforeSeq !== undefined ? { nextBeforeSeq: page.nextBeforeSeq } : {}) };
}

export function researchItemText(item: ResearchItem): string {
  return item.type === "approach" ? item.record.title : item.record.text;
}

/** What a finding's own record puts on its card, lower-cased. An item is replaced when it changes, so this is built once per version. */
const findingCardText = new WeakMap<ResearchItem, string>();

/** The line a finding's card shows for the finding it relates to. */
export function researchFindingRelation(run: Pick<ResearchRunView, "items">, finding: ResearchFinding): string | undefined {
  if (!finding.relatesTo) return undefined;
  const related = run.items.get(finding.relatesTo);
  return `${researchLabel(finding.relation ?? "related")}: ${related?.type === "finding" ? excerpt(related.record.text, 80) : "an earlier finding"}`;
}

/**
 * The findings whose card shows `query`, newest first. A card shows the
 * finding's kind, its text, its evidence paths, the title of its approach and
 * a line for the finding it relates to, so each of those matches. The
 * window's store holds every item, so this reads no page from the owner; the
 * caller draws as many as it shows.
 */
export function researchFindingMatches(run: Pick<ResearchRunView, "items">, query: string): ResearchFinding[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];
  const titled = new Map<string, boolean>();
  const titleMatches = (approachId: string) => {
    let matches = titled.get(approachId);
    if (matches === undefined) {
      matches = approachTitle(run, approachId).toLowerCase().includes(wanted);
      titled.set(approachId, matches);
    }
    return matches;
  };
  const found: Array<{ id: string; createdSeq: number; record: ResearchFinding }> = [];
  for (const item of run.items.values()) {
    if (item.type !== "finding") continue;
    let text = findingCardText.get(item);
    if (text === undefined) {
      text = [item.record.kind, researchLabel(item.record.kind), item.record.text, ...item.record.paths].join("\n").toLowerCase();
      findingCardText.set(item, text);
    }
    if (text.includes(wanted) || titleMatches(item.record.approachId) || researchFindingRelation(run, item.record)?.toLowerCase().includes(wanted)) found.push({ id: item.id, createdSeq: item.createdSeq, record: item.record });
  }
  return found.sort((a, b) => b.createdSeq - a.createdSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((entry) => entry.record);
}

/**
 * The loaded part of the unfiltered findings list: one contiguous stretch,
 * newest first, from the newest finding. `next` continues it while older
 * findings remain. `revision` is the board revision of the last page merged,
 * which a continuing search must name.
 */
export type ResearchFindingsWindow = { key: string; hits: ResearchSearchHit[]; total: number; revision: number; loaded: boolean; next?: NonNullable<ResearchSearchQuery["cursor"]> };

export function emptyResearchFindings(key: string): ResearchFindingsWindow {
  return { key, hits: [], total: 0, revision: 0, loaded: false };
}

/**
 * Merge a read of the first page. The page is the top of the list as it
 * stands now, so it replaces the window down to the page's last hit and the
 * window keeps what it holds below that. If the window does not reach the
 * page's last hit, more arrived than one page holds: the window restarts
 * from the page, and Show more reaches the rest.
 *
 * Below the first page the window is as it was read. Findings are only ever
 * added and keep their order, so that is exact.
 */
export function mergeResearchFindingsHead(window: ResearchFindingsWindow, page: ResearchSearchPage): ResearchFindingsWindow {
  const fromPage = (): ResearchFindingsWindow => ({ key: window.key, hits: page.items, total: page.total, revision: page.revision, loaded: true, ...(page.nextCursor ? { next: page.nextCursor } : {}) });
  const last = page.items.at(-1);
  // A page with nothing after it is the whole list.
  if (!window.loaded || !last || !page.nextCursor) return fromPage();
  const index = window.hits.findIndex((hit) => hit.id === last.id);
  if (index < 0) return fromPage();
  const below = window.hits.slice(index + 1);
  // A window that ended at the page's last hit continues from the page's cursor.
  const { next: _next, ...rest } = window;
  const next = below.length ? window.next : page.nextCursor;
  return { ...rest, hits: [...page.items, ...below], total: page.total, revision: page.revision, ...(next ? { next } : {}) };
}

/** The cursor that continues the window below its oldest hit, at the board revision the window last saw. */
export function researchFindingsOlderCursor(window: ResearchFindingsWindow): ResearchSearchQuery["cursor"] {
  return window.next ? { ...window.next, revision: window.revision } : undefined;
}

/** Append an older page. A page that repeats a loaded hit, such as one read before a restart, is ignored. */
export function appendResearchFindingsOlder(window: ResearchFindingsWindow, page: ResearchSearchPage): ResearchFindingsWindow {
  const loaded = new Set(window.hits.map((hit) => hit.id));
  if (!window.next || page.items.some((hit) => loaded.has(hit.id))) return window;
  const { next: _previous, ...rest } = window;
  return { ...rest, hits: [...window.hits, ...page.items], total: page.total, revision: page.revision, ...(page.nextCursor ? { next: page.nextCursor } : {}) };
}

/** A finding or candidate on the map, with the focused children that investigate it. */
export type ResearchMapLeaf =
  | { type: "finding"; record: ResearchFinding; children: ResearchMapBranch[] }
  | { type: "submission"; record: ResearchSubmission; children: ResearchMapBranch[] };
export type ResearchMapBranch = { approach: ResearchApproach; leaves: ResearchMapLeaf[]; hidden: number; assignments: ResearchMapBranch[] };

/**
 * Approaches with their newest contributions, newest first. Each approach's
 * counts and newest few contribution IDs come from `run.leaves`, which the
 * owner reads per approach, so the Map never walks every finding. A focused
 * child nests under the item it investigates, with its own contributions; one
 * whose source is not among the shown leaves attaches to the source's branch.
 * Every approach appears exactly once: a child whose source is missing, or
 * whose chain of sources loops, stays reachable as a top-level branch.
 * `hidden` counts the contributions a branch does not show.
 */
export function researchMapBranches(run: Pick<ResearchRunView, "approaches" | "items" | "leaves" | "harness">): ResearchMapBranch[] {
  /** Children by the ID they nest under: a shown leaf, or the approach that owns their source. */
  const childrenOf = new Map<string, Array<{ approach: ResearchApproach; sourceSeq: number }>>();
  const rooted = new Set<string>();
  const approaches = run.harness ? run.approaches.filter((a) => run.harness!.members.some((_, index) => a.id === `a${index + 1}`)) : run.approaches;
  for (const approach of approaches) {
    const source = approach.itemId && approach.itemId !== approach.id ? run.items.get(approach.itemId) : undefined;
    if (!source) { rooted.add(approach.id); continue; }
    const shown = source.type === "approach" || run.leaves.get(source.approachId)?.leafIds.includes(source.id);
    // A hidden contribution's children follow the branch's own, newest source first.
    const under = shown ? source.id : source.approachId;
    childrenOf.set(under, [...(childrenOf.get(under) ?? []), { approach, sourceSeq: shown ? Number.MAX_SAFE_INTEGER : source.createdSeq }]);
  }
  const placed = new Set<string>();
  const build = (approach: ResearchApproach): ResearchMapBranch => {
    placed.add(approach.id);
    const nest = (id: string) => (childrenOf.get(id) ?? []).filter((child) => !placed.has(child.approach.id))
      .sort((a, b) => b.sourceSeq - a.sourceSeq).map((child) => build(child.approach));
    const entry = run.leaves.get(approach.id);
    const assignments = nest(approach.id);
    const leaves = (entry?.leafIds ?? []).flatMap((id): ResearchMapLeaf[] => {
      const item = run.items.get(id);
      return item && item.type !== "approach" ? [{ type: item.type, record: item.record, children: nest(id) } as ResearchMapLeaf] : [];
    });
    return { approach, leaves, hidden: Math.max(0, (entry ? entry.findings + entry.candidates : 0) - leaves.length), assignments };
  };
  const branches = approaches.filter((approach) => rooted.has(approach.id)).map(build);
  // A loop of children whose sources are each other has no root; keep each reachable.
  for (const approach of approaches) if (!placed.has(approach.id)) branches.push(build(approach));
  return branches;
}

/** The state an approach's chip shows. An abandoned direction reads "Abandoned", whatever state its worker is in. */
export function researchApproachStateLabel(approach: Pick<ResearchApproach, "state" | "directionState">): string {
  return researchLabel(approach.directionState === "abandoned" ? "abandoned" : approach.state);
}

/** What the Map puts before the title of a branch nested under the item it investigates. */
export const RESEARCH_FOCUSED_CHILD_PREFIX = "Focused child · ";

/** A candidate's review status: its decision, or "Awaiting review" while it has none. A search hit names that "unreviewed". */
export function researchReviewStatusLabel(decision: string | undefined): string {
  return decision && decision !== "unreviewed" ? researchLabel(decision) : "Awaiting review";
}

/** The label before a contribution on the Map: a finding's kind, or a candidate's review status. */
export function researchMapLeafLabel(leaf: ResearchMapLeaf): string {
  return leaf.type === "finding" ? researchLabel(leaf.record.kind) : `Candidate · ${researchReviewStatusLabel(leaf.record.review?.decision)}`;
}

/** The Map's line for the approach this one overlaps. */
export function researchApproachOverlap(run: Pick<ResearchRunView, "items">, approach: ResearchApproach): string | undefined {
  return approach.overlapsApproachId ? `Overlaps ${approachTitle(run, approach.overlapsApproachId)}` : undefined;
}

/** The Map's link to the contributions a branch does not draw. */
export function researchMapMoreLabel(branch: Pick<ResearchMapBranch, "approach" | "hidden">): string | undefined {
  return branch.hidden > 0 ? `${branch.hidden} more from ${branch.approach.title}` : undefined;
}

/**
 * The lines a branch itself draws, without the branches nested in it: its
 * title, state chip, task, note and overlap line, each shown contribution
 * with its label, and the count of the rest. A contribution also matches by
 * the text its excerpt cuts off. The "Open worker" link is a control and is
 * not listed, like "Open source thread" on a finding's card.
 * `ResearchPanel.test.tsx` checks the rendered branch against these lines.
 */
function researchMapBranchLines(run: Pick<ResearchRunView, "items">, branch: ResearchMapBranch, nested: boolean): string[] {
  const { approach } = branch;
  return [`${nested ? RESEARCH_FOCUSED_CHILD_PREFIX : ""}${approach.title}`, researchApproachStateLabel(approach), approach.task, approach.note ?? "", researchApproachOverlap(run, approach) ?? "",
    ...branch.leaves.flatMap((leaf) => [`${researchMapLeafLabel(leaf)} ${excerpt(leaf.record.text)}`, leaf.record.text]), researchMapMoreLabel(branch) ?? ""];
}

/** Text as the Map draws it and as a filter box holds it: each run of white space is one space. */
function researchDrawnText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The top-level branches that show `query`, in the order given; all of them
 * for an empty query. A branch is drawn with the branches nested in it, so
 * text in any of those keeps it. The lines come from the functions the Map
 * renders with, and from the window's store alone: nothing is read from the
 * owner, and a contribution the branch only counts does not match.
 */
export function researchMapMatches(run: Pick<ResearchRunView, "items">, branches: ResearchMapBranch[], query: string): ResearchMapBranch[] {
  const wanted = researchDrawnText(query);
  if (!wanted) return branches;
  const shows = (branch: ResearchMapBranch, nested: boolean): boolean => researchMapBranchLines(run, branch, nested).some((line) => researchDrawnText(line).includes(wanted))
    || branch.leaves.some((leaf) => leaf.children.some((child) => shows(child, true)))
    || branch.assignments.some((child) => shows(child, true));
  return branches.filter((branch) => shows(branch, false));
}
