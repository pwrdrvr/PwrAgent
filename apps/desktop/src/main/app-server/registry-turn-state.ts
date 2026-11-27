import type { AppServerCollaborationModeRequest } from "@pwragent/shared/contracts/agent";
import { buildPendingTurnId, isPendingTurnId } from "@pwragent/shared/turn-placeholder";
import type { TurnInputSource } from "@pwragent/owner-core/turn-input-source";
import type {
  AppServerBackendKind,
  AppServerThreadStatus,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import type { CodexRetryableOperation, PendingReviewStartRecord, ReviewSubAgentRecord, ReviewTerminal, StartingTurnOrigin } from "./backend-registry-types";
import {
  codexThreadHasActiveTurn,
  activeCodexOperation,
  idleCodexThreadActivity,
  transition,
  type CodexStartReservation,
  type CodexStatusObservation,
  type CodexThreadActivity,
  type CodexThreadActivityEvent,
  type ReviewAdmission,
  type ReviewChildLink,
  type CodexOperationPatch,
  type CodexOperationReceipt,
} from "./codex-thread-activity";
import { buildActiveTurnKey, buildActiveTurnModeKey, parseActiveTurnKey, parseThreadTurnKeyBody } from "./thread-turn-keys";

type TurnIdentity = { backend: AppServerBackendKind; threadId: string; turnId: string };
type TurnInputSourceRecord = {
  source: TurnInputSource;
  reviewFix?: boolean;
  admittedCodexTurnSequence?: number;
};
const turnInputSourceKey = ({ backend, threadId, turnId }: TurnIdentity): string => JSON.stringify([backend, threadId, turnId]);
type CodexTurnReference = string | Pick<TurnIdentity, "threadId" | "turnId">;
type TurnReference = string | TurnIdentity;
type ReviewProjection = {
  readonly live: ReadonlyMap<string, ReviewSubAgentRecord>;
  readonly children: ReadonlyMap<string, Omit<ReviewChildLink, "key">>;
};
export type CodexStartDeliveryReceipt = Readonly<{ threadId: string; turnId: string; owner: object }>;

/** In-memory activity owner, constructed by the owner composition root. */
export class RegistryTurnState {
  private readonly activities = new Map<string, CodexThreadActivity>();
  private readonly otherProviderReviewActivities = new Map<string, {
    backend: Exclude<AppServerBackendKind, "codex">; threadId: string; state: CodexThreadActivity;
  }>();
  // These entries genuinely belong to other providers, not to Codex's model.
  private readonly otherProviderRegistrations = new Map<string, { turn: TurnIdentity; order: number }>();
  private readonly otherProviderTurnsByThread = new Map<string, Set<TurnIdentity>>();
  private readonly otherProviderOrigins = new Set<StartingTurnOrigin>();
  private readonly turnInputSources = new Map<string, TurnInputSourceRecord>();
  private readonly deletionListeners = new Set<(key: string) => void>();
  // Immutable projections, invalidated by the canonical state commit. Streamed
  // events must not scan idle thread history just to ask whether reviews exist.
  private cachedReviewProjection: ReviewProjection | undefined = { live: new Map(), children: new Map() };
  private order = 0;
  private statusSequence = 0;
  private readonly emptyActivity = idleCodexThreadActivity();

  codex(threadId: string): CodexThreadActivity {
    return this.activities.get(threadId) ?? this.emptyActivity;
  }

  transition(threadId: string, event: CodexThreadActivityEvent): void {
    const previous = this.codex(threadId);
    const next = transition(previous, event);
    if (previous === next) return;
    this.commitCodexActivity(threadId, previous, next);
    // Commit before invoking synchronous quit/restart listeners. No side map
    // of Codex registration keys is maintained.
    for (const turn of previous.turns) {
      if (turn.phase !== "announced") continue;
      if (next.turns.some(candidate => candidate.turnId === turn.turnId && candidate.phase === "announced")) continue;
      const key = buildActiveTurnKey("codex", threadId, turn.turnId);
      this.turnInputSources.delete(turnInputSourceKey({ backend: "codex", threadId, turnId: turn.turnId }));
      for (const listener of this.deletionListeners) listener(key);
    }
  }

  private invalidateReviewProjection(previous: CodexThreadActivity, next: CodexThreadActivity): void {
    if (previous.liveReviews !== next.liveReviews || previous.reviewChildren !== next.reviewChildren) this.cachedReviewProjection = undefined;
  }

  private commitCodexActivity(threadId: string, previous: CodexThreadActivity, next: CodexThreadActivity): void {
    // Like the old collections, an unobserved idle listing row owns no memory.
    // Keep high-water marks and request/history evidence when they do exist.
    const forget = next.phase === "idle" && next.statusWatermark === 0 && !next.observation
      && next.turns.length === 0 && next.operations.length === 0 && next.deliveries.length === 0
      && next.origins.length === 0 && next.admissions.length === 0 && next.reviewStarts.length === 0
      && next.liveReviews.length === 0 && next.reviewChildren.length === 0;
    if (forget) this.activities.delete(threadId);
    else this.activities.set(threadId, next);
    this.invalidateReviewProjection(previous, next);
  }

  hasActiveTurn(threadId: string, ignoreStartReservation = false): boolean {
    return codexThreadHasActiveTurn(this.codex(threadId), ignoreStartReservation);
  }

  reserveStart(threadId: string, kind: CodexStartReservation["kind"], owner: object = {}): object {
    this.transition(threadId, { type: "reserve", reservation: { kind, owner } });
    return owner;
  }

  releaseStart(threadId: string, owner: object | undefined): void {
    if (owner) this.transition(threadId, { type: "release", owner });
  }

  hasStartReservation(threadId: string): boolean { return Boolean(this.codex(threadId).reservation); }
  startReservationThreadIds(): string[] { return [...this.activities].filter(([, state]) => state.reservation).map(([id]) => id); }
  get startReservationCount(): number { return this.startReservationThreadIds().length; }

  beginStartDelivery(threadId: string, turnId: string): CodexStartDeliveryReceipt {
    const owner = {};
    this.transition(threadId, { type: "startDelivery", turnId, owner });
    return { threadId, turnId, owner };
  }
  endStartDelivery(receipt: CodexStartDeliveryReceipt): void {
    this.transition(receipt.threadId, { type: "finishDelivery", owner: receipt.owner });
  }
  canCommitStart(receipt: CodexStartDeliveryReceipt): boolean {
    return this.codex(receipt.threadId).deliveries.some(delivery => delivery.owner === receipt.owner && delivery.phase === "pending");
  }
  observeTurnTerminal(threadId: string, turnId: string | undefined): void {
    if (turnId) {
      this.turnInputSources.delete(turnInputSourceKey({ backend: "codex", threadId, turnId }));
      this.transition(threadId, { type: "terminalDelivery", turnId });
    }
  }
  pendingStartedTurnId(threadId: string): string | undefined {
    return this.codex(threadId).deliveries.find(delivery => delivery.phase === "pending" && !delivery.turnId.startsWith("pending:"))?.turnId;
  }

  registerTurn(reference: TurnReference, delivery?: CodexStartDeliveryReceipt): void {
    const turn = this.registeredIdentity(reference);
    const key = typeof reference === "string" ? reference : buildActiveTurnKey(reference.backend, reference.threadId, reference.turnId);
    if (!turn) throw new Error(`Invalid registered turn identity: ${key}`);
    if (turn.backend === "codex") this.transition(turn.threadId, { type: "announced", turnId: turn.turnId, order: ++this.order, delivery: delivery?.owner });
    else if (!this.otherProviderRegistrations.has(key)) {
      const registered = { ...turn };
      this.otherProviderRegistrations.set(key, { turn: registered, order: ++this.order });
      const threadKey = buildThreadIdentityKey(turn.backend, turn.threadId);
      let turns = this.otherProviderTurnsByThread.get(threadKey);
      if (!turns) {
        turns = new Set();
        this.otherProviderTurnsByThread.set(threadKey, turns);
      }
      turns.add(registered);
    }
  }

  unregisterTurn(reference: TurnReference): boolean {
    const turn = this.registeredIdentity(reference);
    const key = typeof reference === "string" ? reference : buildActiveTurnKey(reference.backend, reference.threadId, reference.turnId);
    if (!turn) return false;
    this.turnInputSources.delete(turnInputSourceKey(turn));
    if (turn.backend === "codex") {
      const registered = this.hasRegisteredTurn(turn);
      this.transition(turn.threadId, { type: "unregistered", turnId: turn.turnId });
      return registered;
    }
    const registered = this.otherProviderRegistrations.get(key);
    if (!registered) return false;
    this.otherProviderRegistrations.delete(key);
    const threadKey = buildThreadIdentityKey(registered.turn.backend, registered.turn.threadId);
    const turns = this.otherProviderTurnsByThread.get(threadKey)!;
    turns.delete(registered.turn);
    if (!turns.size) this.otherProviderTurnsByThread.delete(threadKey);
    for (const listener of this.deletionListeners) listener(key);
    return true;
  }

  hasRegisteredTurn(reference: TurnReference): boolean {
    const turn = this.registeredIdentity(reference);
    const key = typeof reference === "string" ? reference : buildActiveTurnKey(reference.backend, reference.threadId, reference.turnId);
    return turn?.backend === "codex"
      ? this.codex(turn.threadId).turns.some(candidate => candidate.turnId === turn.turnId && candidate.phase === "announced")
      : this.otherProviderRegistrations.has(key);
  }

  registeredOtherProviderTurnsForThread(thread: Pick<TurnIdentity, "backend" | "threadId">): TurnIdentity[] {
    return Array.from(this.otherProviderTurnsByThread.get(buildThreadIdentityKey(thread.backend, thread.threadId)) ?? []);
  }

  activeTurnIdForThread({ backend, threadId }: Pick<TurnIdentity, "backend" | "threadId">): string | undefined {
    if (backend !== "codex") {
      return this.otherProviderTurnsByThread.get(buildThreadIdentityKey(backend, threadId))?.values().next().value?.turnId;
    }
    let earliestOrder = Infinity;
    let turnId: string | undefined;
    for (const turn of this.codex(threadId).turns) {
      if (turn.execution && turn.execution.order < earliestOrder && !turn.turnId.startsWith("pending:")) {
        earliestOrder = turn.execution.order;
        turnId = turn.turnId;
      }
    }
    return turnId;
  }

  registeredTurnKeys(): string[] {
    const entries = Array.from(this.otherProviderRegistrations, ([key, { order }]): [string, number] => [key, order]);
    for (const [threadId, state] of this.activities) {
      for (const turn of state.turns) {
        if (turn.phase === "announced") entries.push([buildActiveTurnKey("codex", threadId, turn.turnId), turn.registration]);
      }
    }
    return entries.sort((left, right) => left[1] - right[1]).map(([key]) => key);
  }

  get registeredTurnCount(): number { return this.registeredTurnKeys().length; }
  onTurnUnregistered(listener: (key: string) => void): () => void {
    this.deletionListeners.add(listener);
    return () => { this.deletionListeners.delete(listener); };
  }

  private registeredIdentity(reference: TurnReference): TurnIdentity | undefined {
    if (typeof reference !== "string") return reference;
    const parsed = parseActiveTurnKey(reference);
    if (parsed?.backend === "codex") {
      const identity = this.codexIdentity(reference.slice("codex:".length));
      return identity ? { backend: "codex", ...identity } : parsed;
    }
    return parsed;
  }

  private codexIdentity(reference: CodexTurnReference): Pick<TurnIdentity, "threadId" | "turnId"> | undefined {
    if (typeof reference !== "string") return reference;
    const parsed = parseThreadTurnKeyBody(reference);
    if (parsed && this.codex(parsed.threadId).turns.some(turn => turn.turnId === parsed.turnId)) return parsed;
    // Iteration projections retain their canonical strings. Resolve a known
    // placeholder by its stored identity rather than guessing its separators.
    for (const [threadId, state] of this.activities) {
      const turn = state.turns.find(turn => buildActiveTurnModeKey(threadId, turn.turnId) === reference);
      if (turn) return { threadId, turnId: turn.turnId };
    }
    return parsed;
  }

  private turn(reference: CodexTurnReference) {
    const identity = this.codexIdentity(reference);
    return identity ? this.codex(identity.threadId).turns.find(turn => turn.turnId === identity.turnId) : undefined;
  }

  private transitionTurn(reference: CodexTurnReference, event: CodexThreadActivityEvent): void {
    const identity = this.codexIdentity(reference);
    if (!identity) throw new Error("Invalid Codex turn identity");
    this.transition(identity.threadId, event);
  }

  acceptExecution(key: CodexTurnReference, mode: ThreadExecutionMode): void {
    const turn = this.codexIdentity(key);
    if (!turn) throw new Error("Invalid Codex turn identity");
    this.transition(turn.threadId, { type: "executionAccepted", turnId: turn.turnId, mode, order: ++this.order });
  }

  resolveExecution(key: CodexTurnReference, registration: number, mode: ThreadExecutionMode): void {
    const turn = this.codexIdentity(key);
    if (!turn) throw new Error("Invalid Codex turn identity");
    this.transition(turn.threadId, { type: "executionResolved", turnId: turn.turnId, registration, mode, order: ++this.order });
  }

  registration(key: CodexTurnReference): number | undefined { return this.turn(key)?.registration; }
  executionMode(key: CodexTurnReference): ThreadExecutionMode | undefined { return this.turn(key)?.execution?.mode; }
  ownsExecution(key: CodexTurnReference): boolean { return Boolean(this.turn(key)?.execution); }
  changeExecution(key: CodexTurnReference, mode: ThreadExecutionMode): void {
    const identity = this.codexIdentity(key);
    if (identity) this.transition(identity.threadId, { type: "executionChanged", turnId: identity.turnId, mode });
  }
  forgetExecution(key: CodexTurnReference): void {
    const identity = this.codexIdentity(key);
    if (identity) this.transitionTurn(key, { type: "executionForgotten", turnId: identity.turnId });
  }

  executionEntries(): Array<[string, ThreadExecutionMode]> {
    const entries: Array<{ key: string; mode: ThreadExecutionMode; order: number }> = [];
    for (const [threadId, state] of this.activities) {
      for (const turn of state.turns) {
        if (turn.execution) entries.push({ key: buildActiveTurnModeKey(threadId, turn.turnId), ...turn.execution });
      }
    }
    return entries.sort((left, right) => left.order - right.order).map(({ key, mode }) => [key, mode]);
  }
  executionKeys(): string[] { return this.executionEntries().map(([key]) => key); }
  get executionCount(): number { return this.executionEntries().length; }

  collaborationMode(key: TurnReference): AppServerCollaborationModeRequest["mode"] | undefined {
    const identity = this.registeredIdentity(key);
    return identity?.backend === "codex"
      ? this.turn(identity)?.collaboration : undefined;
  }
  setCollaboration(key: TurnReference, mode?: AppServerCollaborationModeRequest["mode"]): void {
    const identity = this.registeredIdentity(key);
    if (identity?.backend === "codex") this.transition(identity.threadId, { type: "collaboration", turnId: identity.turnId, mode });
  }
  forgetCollaboration(key: TurnReference): void { this.setCollaboration(key); }
  collaborationKeys(): string[] {
    return [...this.activities].flatMap(([threadId, state]) => state.turns.filter(turn => turn.collaboration !== undefined)
      .map(turn => buildActiveTurnKey("codex", threadId, turn.turnId)));
  }

  markReview(key: CodexTurnReference): void {
    const identity = this.codexIdentity(key);
    if (identity) this.transition(identity.threadId, { type: "review", turnId: identity.turnId, active: true, order: ++this.order });
  }
  forgetReview(key: CodexTurnReference): void {
    const identity = this.codexIdentity(key);
    if (identity) this.transition(identity.threadId, { type: "review", turnId: identity.turnId, active: false, order: ++this.order });
  }
  isReview(key: CodexTurnReference): boolean { return this.turn(key)?.review?.phase === "active"; }
  reviewKeys(): string[] {
    return [...this.activities].flatMap(([id, state]) => state.turns.flatMap(turn => turn.review?.phase === "active"
      ? [{ key: buildActiveTurnModeKey(id, turn.turnId), order: turn.review.order }] : []))
      .sort((left, right) => left.order - right.order).map(({ key }) => key);
  }
  setReviewInterrupt(key: CodexTurnReference, interruptTurnId?: string): void {
    const identity = this.codexIdentity(key);
    if (identity) this.transition(identity.threadId, { type: "reviewInterrupt", turnId: identity.turnId, interruptTurnId, order: ++this.order });
  }
  forgetReviewInterrupt(key: CodexTurnReference): void { this.setReviewInterrupt(key); }
  reviewInterrupt(key: CodexTurnReference): string | undefined { return this.turn(key)?.review?.interruptTurnId; }
  reviewInterruptEntries(): Array<[string, string]> {
    return [...this.activities].flatMap(([id, state]) => state.turns.flatMap(turn => turn.review?.interruptTurnId
      ? [{ key: buildActiveTurnModeKey(id, turn.turnId), turnId: turn.review.interruptTurnId, order: turn.review.interruptOrder! }] : []))
      .sort((left, right) => left.order - right.order).map(({ key, turnId }) => [key, turnId]);
  }

  retryOperation(threadId: string): CodexOperationReceipt | undefined { return activeCodexOperation(this.codex(threadId)); }
  assignRetry(threadId: string, operation: CodexRetryableOperation): void { this.transition(threadId, { type: "retry", operation }); }
  forgetRetry(threadId: string): void { this.transition(threadId, { type: "retry" }); }
  hasRetry(threadId: string): boolean { return Boolean(this.retryOperation(threadId)); }
  retryEntries(): Array<[string, CodexOperationReceipt]> {
    return [...this.activities].flatMap(([id, state]) => {
      const operation = activeCodexOperation(state);
      return operation ? [[id, operation] as [string, CodexOperationReceipt]] : [];
    });
  }
  retryOperations(): CodexOperationReceipt[] { return this.retryEntries().map(([, retry]) => retry); }
  private operationOwner(operation: CodexRetryableOperation): object {
    return "owner" in operation ? (operation as CodexOperationReceipt).owner : operation;
  }
  retryReceipt<Operation extends CodexRetryableOperation>(operation: Operation): Readonly<Operation> {
    // The receipt's kind and request never change; only lifecycle fields do.
    return (this.codex(operation.params.threadId).operations.find(receipt => receipt.owner === this.operationOwner(operation)) ?? operation) as Readonly<Operation>;
  }
  ownsRetry(threadId: string, operation: CodexRetryableOperation): boolean {
    return this.retryOperation(threadId)?.owner === this.operationOwner(operation);
  }
  updateRetry<Operation extends CodexRetryableOperation>(operation: Operation, patch: CodexOperationPatch): Readonly<Operation> {
    this.transition(operation.params.threadId, { type: "retryUpdated", owner: this.operationOwner(operation), patch });
    return this.retryReceipt(operation);
  }
  releaseRetryReceipt(operation: CodexRetryableOperation): void {
    this.transition(operation.params.threadId, { type: "retryReleased", owner: this.operationOwner(operation) });
  }

  reserveStatusSequence(): number { return ++this.statusSequence; }
  statusWatermark(threadId: string): number { return this.codex(threadId).statusWatermark; }
  statusObservation(threadId: string): CodexStatusObservation | undefined { return this.codex(threadId).observation; }
  observeStatus(threadId: string, status: AppServerThreadStatus, sequence: number): void {
    this.transition(threadId, { type: "observe", observation: { status, sequence }, order: ++this.order });
  }
  seedStatus(threadId: string, status?: AppServerThreadStatus): void {
    if (!status || (status !== "active" && !this.activities.has(threadId))) return;
    this.transition(threadId, { type: "seed", status, order: ++this.order });
  }
  acknowledgeObservation(threadId: string, observation: CodexStatusObservation): void {
    this.transition(threadId, { type: "acknowledgeObservation", observation });
  }
  restoreObservation(threadId: string, sequence: number, previous?: CodexStatusObservation): void {
    this.transition(threadId, { type: "restoreObservation", sequence, previous, order: ++this.order });
  }
  providerActive(threadId: string): boolean { return this.codex(threadId).providerStatus === "active"; }
  providerActiveThreadIds(): string[] {
    return [...this.activities].filter(([, state]) => state.providerStatus === "active")
      .sort((left, right) => left[1].providerOrder! - right[1].providerOrder!).map(([id]) => id);
  }
  get providerActiveCount(): number { return this.providerActiveThreadIds().length; }

  addStartingOrigin(origin: StartingTurnOrigin): void {
    if (origin.backend === "codex") this.transition(origin.threadId, { type: "originAdded", origin, order: ++this.order });
    else this.otherProviderOrigins.add(origin);
  }

  rememberTurnInputSource(
    turn: TurnIdentity,
    source: TurnInputSource,
    admittedCodexTurnSequence?: number,
    reviewFix?: boolean,
  ): void {
    this.turnInputSources.set(turnInputSourceKey(turn), {
      source,
      ...(reviewFix ? { reviewFix: true } : {}),
      admittedCodexTurnSequence,
    });
  }

  readTurnInputSource(turn: TurnIdentity): TurnInputSource | undefined {
    return this.turnInputSources.get(turnInputSourceKey(turn))?.source;
  }

  readTurnReviewFix(turn: TurnIdentity): boolean | undefined {
    const record = this.turnInputSources.get(turnInputSourceKey(turn));
    return record ? record.reviewFix === true : undefined;
  }

  private readPendingCodexTurnInputRecord(
    threadId: string,
    observedSequence: number | undefined,
  ): TurnInputSourceRecord | undefined {
    const pending = this.turnInputSources.get(turnInputSourceKey({ backend: "codex", threadId, turnId: buildPendingTurnId(threadId) }));
    // A redelivered start for an older turn cannot consume a newer admission.
    if (observedSequence !== undefined && observedSequence <= (pending?.admittedCodexTurnSequence ?? -1)) return undefined;
    return pending;
  }

  readPendingCodexTurnInputSource(threadId: string, observedSequence: number | undefined): TurnInputSource | undefined {
    return this.readPendingCodexTurnInputRecord(threadId, observedSequence)?.source;
  }

  readPendingCodexTurnReviewFix(threadId: string, observedSequence: number | undefined): boolean | undefined {
    const pending = this.readPendingCodexTurnInputRecord(threadId, observedSequence);
    return pending ? pending.reviewFix === true : undefined;
  }

  /** Returns false when an older notification must leave the placeholder alone. */
  transferPendingCodexTurnInputSource(threadId: string, turnId: string, observedSequence: number | undefined): boolean {
    if (isPendingTurnId(threadId, turnId)) return true;
    const turn = { backend: "codex" as const, threadId, turnId };
    const pendingKey = turnInputSourceKey({ ...turn, turnId: buildPendingTurnId(threadId) });
    const pending = this.readPendingCodexTurnInputRecord(threadId, observedSequence);
    if (pending === undefined) return !this.turnInputSources.has(pendingKey);
    if (this.readTurnInputSource(turn) === undefined) {
      this.rememberTurnInputSource(turn, pending.source, undefined, pending.reviewFix);
    }
    this.turnInputSources.delete(pendingKey);
    return true;
  }
  removeStartingOrigin(origin: StartingTurnOrigin): void {
    if (origin.backend === "codex") {
      // Binding can change the thread ID while the request is in flight.
      for (const [threadId, state] of this.activities) {
        if (state.origins.some(receipt => receipt.owner === origin)) this.transition(threadId, { type: "originRemoved", origin });
      }
    } else this.otherProviderOrigins.delete(origin);
  }
  startingOrigins(): StartingTurnOrigin[] {
    return [...this.activities.values()].flatMap(state => state.origins)
      .sort((left, right) => left.order - right.order).map(origin => origin.value).concat([...this.otherProviderOrigins]);
  }
  startingOrigin(owner: StartingTurnOrigin): StartingTurnOrigin {
    return [...this.activities.values()].flatMap(state => state.origins).find(origin => origin.owner === owner)?.value ?? owner;
  }
  bindStartingOrigin(origin: StartingTurnOrigin, turn: { threadId: string; turnId: string }): void {
    if (origin.backend === "codex") {
      for (const [threadId, state] of this.activities) {
        if (state.origins.some(receipt => receipt.owner === origin)) this.transition(threadId, { type: "originBound", origin, turn });
      }
    } else {
      origin.threadId = turn.threadId;
      origin.turnId = turn.turnId;
    }
  }

  private reviewActivities() {
    return [...this.activities].map(([threadId, state]) => ({ backend: "codex" as AppServerBackendKind, threadId, state }))
      .concat([...this.otherProviderReviewActivities.values()]);
  }

  private reviewTransition(identity: { backend: AppServerBackendKind; threadId: string }, event: CodexThreadActivityEvent): void {
    if (identity.backend === "codex") this.transition(identity.threadId, event);
    else {
      const key = buildThreadIdentityKey(identity.backend, identity.threadId);
      const previous = this.otherProviderReviewActivities.get(key)?.state ?? this.emptyActivity;
      const next = transition(previous, event);
      this.otherProviderReviewActivities.set(key, { backend: identity.backend, threadId: identity.threadId, state: next });
      this.invalidateReviewProjection(previous, next);
    }
  }

  reviewAdmissions(): PendingReviewStartRecord[] { return this.reviewActivities().flatMap(({ state }) => state.admissions); }
  reviewAdmission(id: string): PendingReviewStartRecord | undefined { return this.reviewAdmissions().find(admission => admission.pendingReviewId === id); }
  setReviewAdmission(record: PendingReviewStartRecord): void {
    let admission: ReviewAdmission;
    if (record.status === "started") {
      if (record.reviewThreadId === undefined || record.reviewTurnId === undefined) throw new Error("A started review admission requires its child and turn identities");
      admission = { ...record, status: record.status, reviewThreadId: record.reviewThreadId, reviewTurnId: record.reviewTurnId };
    } else if (record.status === "failed" || record.status === "cancelled") {
      if (record.error === undefined) throw new Error("A refused review admission requires its reason");
      admission = { ...record, status: record.status, error: record.error };
    } else admission = { ...record, status: record.status };
    this.reviewTransition(record, { type: "reviewAdmission", admission });
  }

  beginReviewStart(identity: { backend: AppServerBackendKind; threadId: string }): object {
    const owner = {};
    this.reviewTransition(identity, { type: "reviewStartOpened", owner });
    return owner;
  }
  endReviewStart(owner: object): void {
    for (const activity of this.reviewActivities()) {
      if (activity.state.reviewStarts.some(start => start.owner === owner)) this.reviewTransition(activity, { type: "reviewStartClosed", owner });
    }
  }
  recordReviewTerminal(terminal: ReviewTerminal): void {
    for (const activity of this.reviewActivities()) {
      if (activity.state.reviewStarts.length) this.reviewTransition(activity, { type: "reviewTerminal", terminal });
    }
  }
  reviewStartTerminal(owner: object, key: string): ReviewTerminal | undefined {
    for (const { state } of this.reviewActivities()) {
      const start = state.reviewStarts.find(start => start.owner === owner);
      if (start) return start.terminals.find(terminal => buildActiveTurnKey(terminal.backend, terminal.threadId, terminal.turnId) === key);
    }
    return undefined;
  }

  private reviewProjection(): ReviewProjection {
    if (!this.cachedReviewProjection) {
      const activities = this.reviewActivities();
      this.cachedReviewProjection = {
        live: new Map(activities.flatMap(({ state }) => state.liveReviews)
          .sort((left, right) => left.order - right.order)
          .map(({ record }) => [buildActiveTurnKey(record.backend, record.reviewThreadId, record.turnId), record])),
        children: new Map(activities.flatMap(({ state }) => state.reviewChildren)
          .map(link => [link.key, { parentBackend: link.parentBackend, parentThreadId: link.parentThreadId }])),
      };
    }
    return this.cachedReviewProjection;
  }
  liveReviewRecords(): ReadonlyMap<string, ReviewSubAgentRecord> { return this.reviewProjection().live; }
  liveReviewForParent(backend: AppServerBackendKind, threadId: string, turnId?: string): ReviewSubAgentRecord | undefined {
    const state = backend === "codex"
      ? this.codex(threadId)
      : this.otherProviderReviewActivities.get(buildThreadIdentityKey(backend, threadId))?.state;
    return state?.liveReviews.find(({ record }) => !turnId || record.turnId === turnId)?.record;
  }
  activateReview(record: ReviewSubAgentRecord): void {
    this.reviewTransition({ backend: record.parentBackend, threadId: record.parentThreadId }, { type: "reviewActivated", record, order: ++this.order });
  }
  finishReview(key: string): void {
    const record = this.liveReviewRecords().get(key);
    if (record) this.reviewTransition({ backend: record.parentBackend, threadId: record.parentThreadId }, { type: "reviewFinished", record });
  }

  reviewChildParent(key: string): Omit<ReviewChildLink, "key"> | undefined { return this.reviewProjection().children.get(key); }
  linkReviewChild(key: string, parent: Omit<ReviewChildLink, "key">): void {
    this.unlinkReviewChild(key);
    this.reviewTransition({ backend: parent.parentBackend, threadId: parent.parentThreadId }, {
      type: "reviewChildLinked", link: { key, parentBackend: parent.parentBackend, parentThreadId: parent.parentThreadId },
    });
  }
  unlinkReviewChild(key: string): void {
    for (const activity of this.reviewActivities()) {
      if (activity.state.reviewChildren.some(link => link.key === key)) this.reviewTransition(activity, { type: "reviewChildUnlinked", key });
    }
  }
}
