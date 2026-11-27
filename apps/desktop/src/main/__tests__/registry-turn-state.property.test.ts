import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import ts from "typescript";
import { expect, it } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import {
  type AppServerBackendKind,
  type ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import { registryModules } from "../app-server/backend-registry-wiring";
import type { CodexRetryableCompaction, ReviewSubAgentRecord } from "../app-server/backend-registry-types";
import { RegistryTurnState } from "../app-server/registry-turn-state";
import type { StateDb } from "../state/state-db";
import { registryWithInMemoryStore } from "./helpers/registry-in-memory-fixture";

it("correlates pending notification delivery with terminals and disposes its receipt", () => {
  fc.assert(fc.property(fc.boolean(), matching => {
    const state = new RegistryTurnState();
    const identity = { backend: "codex" as const, threadId: "thread", turnId: "turn" };
    const receipt = state.beginStartDelivery(identity.threadId, identity.turnId);
    state.observeTurnTerminal("thread", matching ? "turn" : "stale-turn");
    expect(state.canCommitStart(receipt)).toBe(!matching);
    state.registerTurn(identity, receipt);
    expect(state.hasRegisteredTurn(identity)).toBe(!matching);
    state.endStartDelivery(receipt);
    expect(state.codex("thread").deliveries).toEqual([]);
  }));
});

it("does not give a competing reservation the current owner's release token", () => {
  const state = new RegistryTurnState();
  const owner = state.reserveStart("thread", "turn");
  const competitor = state.reserveStart("thread", "voice");
  state.releaseStart("thread", competitor);
  expect(state.hasStartReservation("thread")).toBe(true);
  state.releaseStart("thread", owner);
  expect(state.hasStartReservation("thread")).toBe(false);
});

it("preserves provider membership order independently of when a thread was first observed", () => {
  fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom("a", "b", "c"), fc.boolean()), { maxLength: 24, size: "max" }), changes => {
    const state = new RegistryTurnState();
    for (const threadId of ["c", "b", "a"]) state.seedStatus(threadId, "idle");
    const expected = new Set<string>();
    for (const [threadId, active] of [["b", true], ["a", true], ["b", false], ["b", true], ...changes] as Array<[string, boolean]>) {
      if (active) expected.add(threadId);
      else expected.delete(threadId);
      state.seedStatus(threadId, active ? "active" : "idle");
      expect(state.providerActiveThreadIds()).toEqual([...expected]);
    }
  }));
});

it("retains full thread and placeholder identities through ownership and cleanup", () => {
  fc.assert(fc.property(fc.constantFrom("ordinary", "thread:with:colons"), fc.constantFrom("real-turn", "pending:compact:thread", "pending:thread:with:colons"), (threadId, turnId) => {
    const state = new RegistryTurnState();
    const identity = { backend: "codex" as const, threadId, turnId };
    const key = `codex:${threadId}:${turnId}`, modeKey = `${threadId}:${turnId}`;
    state.registerTurn(identity);
    state.acceptExecution(identity, "auto");
    state.setCollaboration(identity, "plan");
    expect(state.registeredTurnKeys()).toEqual([key]);
    expect(state.executionEntries()).toEqual([[modeKey, "auto"]]);
    expect(state.executionMode(identity)).toBe("auto");
    expect(state.executionMode(modeKey)).toBe("auto");
    state.unregisterTurn(key);
    state.forgetExecution(modeKey);
    expect(state.codex(threadId).turns).toEqual([]);
  }));
});

it("retains immutable early-terminal receipts only while an awaiting request needs them", () => {
  const state = new RegistryTurnState();
  const operation: CodexRetryableCompaction = { kind: "compact", params: { backend: "codex", threadId: "thread" }, turnId: "pending:compact:thread" };
  state.assignRetry("thread", operation);
  const before = state.codex("thread");
  state.updateRetry(operation, { lifecycleStarted: true, turnId: "real-turn", terminalObserved: true });
  state.forgetRetry("thread");
  expect(state.hasActiveTurn("thread")).toBe(false);
  expect(state.retryReceipt(operation)).toMatchObject({ turnId: "real-turn", terminalObserved: true });
  expect(operation.turnId).toBe("pending:compact:thread");
  expect(before.operations[0]?.turnId).toBe("pending:compact:thread");
  state.releaseRetryReceipt(operation);
  expect(state.codex("thread").operations).toEqual([]);
});

it("binds causal origins through immutable request ownership until persistence releases them", () => {
  fc.assert(fc.property(fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:grok"), backend => {
    const state = new RegistryTurnState();
    const origin = { backend, threadId: "before", origin: { kind: "pwragent" as const } };
    state.addStartingOrigin(origin);
    const before = state.codex("before");
    const returned = { threadId: "after", turnId: "turn", backend: "unrelated", origin: { kind: "untrusted" } };
    state.bindStartingOrigin(origin, returned);
    expect(state.startingOrigin(origin)).toMatchObject({ threadId: "after", turnId: "turn", backend, origin: origin.origin });
    if (backend === "codex") {
      expect(before.origins[0]?.value.threadId).toBe("before");
      expect(origin.threadId).toBe("before");
    }
    state.removeStartingOrigin(origin);
    expect(state.startingOrigins()).toEqual([]);
  }));
});

it("does not restore a synthetic start observation over a newer provider terminal", () => {
  const state = new RegistryTurnState();
  state.observeStatus("thread", "idle", 1);
  const previous = state.statusObservation("thread");
  state.observeStatus("thread", "active", 2);
  state.observeStatus("thread", "idle", 3);
  const terminal = state.statusObservation("thread")!;
  state.restoreObservation("thread", 2, previous);
  expect(state.statusObservation("thread")).toBe(terminal);
  state.acknowledgeObservation("thread", terminal);
  state.observeStatus("thread", "active", 2);
  expect(state.hasActiveTurn("thread")).toBe(false);
  expect(state.statusWatermark("thread")).toBe(3);
});

it("makes review admission outcomes final and retains early terminals until the owning start returns", () => {
  const state = new RegistryTurnState();
  const admission = {
    pendingReviewId: "review", backend: "codex" as const, threadId: "parent", invokingTurnId: "invoking",
    request: { backend: "codex" as const, threadId: "parent", target: { type: "uncommittedChanges" as const } },
    createdAt: 1, updatedAt: 1, status: "scheduled" as const,
  };
  state.setReviewAdmission(admission);
  state.setReviewAdmission({ ...admission, status: "starting" });
  state.setReviewAdmission({ ...admission, status: "started", reviewThreadId: "child", reviewTurnId: "turn" });
  state.setReviewAdmission({ ...admission, status: "starting" });
  expect(state.reviewAdmission("review")?.status).toBe("started");
  const attempt = state.beginReviewStart({ backend: "codex", threadId: "parent" });
  const terminal = { backend: "codex" as const, threadId: "different-child", turnId: "turn", method: "turn/completed" as const };
  state.recordReviewTerminal(terminal);
  expect(state.reviewStartTerminal(attempt, "codex:different-child:turn")).toBe(terminal);
  state.endReviewStart(attempt);
  expect(state.codex("parent").reviewStarts).toEqual([]);
});

it("keeps early child terminals for each start still open at delivery", () => {
  const state = new RegistryTurnState();
  const parent = { backend: "claude" as const, threadId: "parent" };
  const first = state.beginReviewStart(parent);
  const second = state.beginReviewStart(parent);
  const other = state.beginReviewStart({ ...parent, backend: "codex" });
  state.endReviewStart(first);
  const terminal = { backend: "codex" as const, threadId: "child", turnId: "turn", method: "turn/completed" as const };
  state.recordReviewTerminal(terminal);
  const late = state.beginReviewStart(parent);
  const key = "codex:child:turn";
  expect(state.reviewStartTerminal(first, key)).toBeUndefined();
  expect(state.reviewStartTerminal(second, key)).toBe(terminal);
  expect(state.reviewStartTerminal(other, key)).toBe(terminal);
  expect(state.reviewStartTerminal(late, key)).toBeUndefined();
});

it("rebinds a managed review child without carrying its previous lookup identity", () => {
  fc.assert(fc.property(fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:grok"), backend => {
    const state = new RegistryTurnState();
    const before = buildThreadIdentityKey("codex", "requested-child");
    const after = buildThreadIdentityKey("codex", "returned-child");
    const parent = { parentBackend: backend, parentThreadId: "parent" };
    state.linkReviewChild(before, parent);
    const linked = state.reviewChildParent(before)!;
    state.unlinkReviewChild(before);
    state.linkReviewChild(after, linked);
    expect(state.reviewChildParent(after)).toEqual(parent);
    expect(state.reviewChildParent(before)).toBeUndefined();
    // A structurally compatible metadata value may still carry an old key.
    const metadata = { ...parent, key: before };
    state.linkReviewChild(after, metadata);
    expect(state.reviewChildParent(after)).toEqual(parent);
    expect(state.reviewChildParent(before)).toBeUndefined();
  }));
});

it("derives immutable review views from membership changes across every parent provider", () => {
  fc.assert(fc.property(fc.array(fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:grok"), { minLength: 2, maxLength: 8, size: "max" }), backends => {
    const state = new RegistryTurnState();
    const expected = new Map<string, ReviewSubAgentRecord>();
    const before = state.liveReviewRecords();
    expect(before.size).toBe(0);
    for (const [index, backend] of backends.entries()) {
      const record: ReviewSubAgentRecord = {
        backend: "codex", parentBackend: backend, parentThreadId: `parent-${index}`, reviewThreadId: `child-${index}`,
        turnId: `turn-${index}`, createdAt: index, displayText: "Fixture review", task: "Review", mode: "managed",
      };
      const key = `codex:${record.reviewThreadId}:${record.turnId}`;
      expected.set(key, record);
      state.activateReview(record);
      expect([...state.liveReviewRecords()]).toEqual([...expected]);
      expect(state.liveReviewsForChild(record.backend, record.reviewThreadId)?.get(record.turnId)).toBe(record);
      const projection = state.liveReviewRecords();
      state.seedStatus(`unobserved-idle-${index}`, "idle");
      expect(state.liveReviewRecords()).toBe(projection);
      expect(before.size).toBe(0);
    }
    for (const key of [...expected.keys()].reverse()) {
      const record = expected.get(key)!;
      const childSnapshot = state.liveReviewsForChild(record.backend, record.reviewThreadId);
      expected.delete(key);
      state.finishReview(key);
      expect(childSnapshot?.get(record.turnId)).toBe(record);
      expect(state.liveReviewsForChild(record.backend, record.reviewThreadId)).toBeUndefined();
      expect([...state.liveReviewRecords()]).toEqual([...expected]);
    }
  }));
});

it("preserves global registration/mode order and commits before notifying turn waiters", () => {
  fc.assert(fc.property(fc.array(fc.constantFrom("codex", "claude", "acp:grok"), { minLength: 2, maxLength: 16, size: "max" }), backends => {
    const state = new RegistryTurnState();
    const keys = backends.map((backend, index) => `${backend}:thread-${index % 3}:turn-${index}`);
    for (const key of keys) state.registerTurn(key);
    expect(state.registeredTurnKeys()).toEqual(keys);
    const ended: string[] = [];
    const unsubscribe = state.onTurnUnregistered(key => {
      expect(state.hasRegisteredTurn(key)).toBe(false);
      expect(state.collaborationMode(key)).toBeUndefined();
      ended.push(key);
    });
    const codex = keys.filter(key => key.startsWith("codex:"));
    for (const key of codex) {
      state.setCollaboration(key, "plan");
      state.acceptExecution(key.slice("codex:".length), "default");
    }
    expect(state.executionKeys()).toEqual(codex.map(key => key.slice("codex:".length)));
    for (const key of keys) {
      state.unregisterTurn(key);
      state.unregisterTurn(key);
    }
    expect(ended).toEqual(keys);
    unsubscribe();
  }));
});

it.each<ThreadExecutionMode>(["default", "auto", "full-access"])(
  "routes registry admission and all module readers through the same activity owner in %s mode",
  async (mode) => {
    // Every source is exercised on a thread that was also checked earlier.
    // Each source owns admission independently and retires before the next starts.
    const sources = ["reservation", "registration", "mode", "provider", "compact", "review"] as const;
    const databases: StateDb[] = [];
    const registry = registryWithInMemoryStore(databases);
    const state = registryModules(registry).turnState;
    try {
      for (const [index, source] of [...sources, ...sources.toReversed()].entries()) {
        const threadId = `thread-${index % 2}`, turnId = `turn-${index}`;
        const identity = { backend: "codex" as const, threadId };
        const key = `codex:${threadId}:${turnId}`, modeKey = `${threadId}:${turnId}`;
        const reservation = source === "reservation" ? state.reserveStart(threadId, "revert") : undefined;
        if (source === "registration") state.registerTurn(key);
        if (source === "mode") state.acceptExecution(modeKey, mode);
        if (source === "provider") state.seedStatus(threadId, "active");
        if (source === "compact") {
          const operation: CodexRetryableCompaction = { kind: "compact", params: identity, turnId };
          state.assignRetry(threadId, operation);
          state.releaseRetryReceipt(operation);
        }
        const review: ReviewSubAgentRecord = {
          backend: "claude", parentBackend: "codex", parentThreadId: threadId,
          reviewThreadId: `review-${index}`, turnId, createdAt: index, displayText: "Fixture review", task: "Review", mode: "managed",
        };
        if (source === "review") state.activateReview(review);
        // Registration alone has a different legacy projection from busy
        // admission. All other sources independently own busy admission.
        expect(registry.isThreadTurnOccupied(identity)).toBe(source !== "registration");
        expect(registry.constructionPorts().threadHasActiveTurn(threadId, "codex")).toBe(source !== "registration");
        expect(registry.isThreadTurnOccupied({ ...identity, threadId: "unrelated" })).toBe(false);
        if (reservation) state.releaseStart(threadId, reservation);
        state.unregisterTurn(key);
        state.forgetExecution(modeKey);
        state.seedStatus(threadId, "idle");
        state.forgetRetry(threadId);
        state.finishReview(`claude:${review.reviewThreadId}:${turnId}`);
        expect(registry.isThreadTurnOccupied(identity)).toBe(false);
      }
    } finally {
      await registry.close();
      for (const db of databases) db.close();
    }
  },
);

it.each([true, false])("settles only the accepted compactions owned by an exited process (scoped=%s)", async (scoped) => {
  const databases: StateDb[] = [];
  const registry = registryWithInMemoryStore(databases);
  const { turnState, codexRuntimeSupervisor } = registryModules(registry);
  const operations: CodexRetryableCompaction[] = [];
  try {
    for (const threadId of ["a", "b"]) {
      const operation: CodexRetryableCompaction = { kind: "compact", params: { backend: "codex", threadId }, turnId: `pending:compact:${threadId}` };
      turnState.assignRetry(threadId, operation);
      operations.push(operation);
    }
    await codexRuntimeSupervisor.handleCodexAppServerUnexpectedExit(scoped ? new Set(["a"]) : undefined);
    expect(registry.isThreadTurnOccupied({ backend: "codex", threadId: "a" })).toBe(false);
    expect(registry.isThreadTurnOccupied({ backend: "codex", threadId: "b" })).toBe(scoped);
    expect(turnState.retryReceipt(operations[0]!).terminalObserved).toBe(true);
    turnState.releaseRetryReceipt(operations[0]!);
    expect(turnState.codex("a").operations).toEqual([]);
    turnState.forgetRetry("b");
    turnState.releaseRetryReceipt(operations[1]!);
  } finally {
    await registry.close();
    for (const db of databases) db.close();
  }
});

it("retires legacy activity fields and makes registry busy admission read the union", () => {
  const retired = new Set([
    "reservedCodexStartThreadIds", "activeTurnKeys", "activeCodexTurnModes", "activeCodexTurnCollaborationModes",
    "codexRetryableOperations", "backendActiveCodexThreadIds", "observedCodexThreadStatuses",
    "latestCodexThreadStatusObservationSequences", "codexThreadStatusObservationSequence",
    "activeCodexReviewTurnKeys", "activeCodexReviewInterruptTurnIds", "startingTurnOrigins",
    "pendingReviewStarts", "pendingReviewTerminals", "activeReviewSubAgents", "managedReviewParentsByChildThread",
  ]);
  const directory = new URL("../app-server/", import.meta.url);
  const mentions: string[] = [];
  let readsUnion = false;
  for (const name of readdirSync(directory).filter(name => name.endsWith(".ts"))) {
    const url = new URL(name, directory);
    const file = ts.createSourceFile(fileURLToPath(url), readFileSync(url, "utf8"), ts.ScriptTarget.Latest);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && retired.has(node.text)) mentions.push(`${name}:${node.text}`);
      if (name === "backend-registry.ts" && ts.isMethodDeclaration(node) && node.name.getText(file) === "threadHasActiveTurn") {
        const [threadId, , ignoreReservation] = node.parameters.map(({ name }) => name.getText(file));
        readsUnion = ts.forEachChild(node, function findUnionReturn(child): true | undefined {
          if (ts.isReturnStatement(child) && child.expression && ts.isCallExpression(child.expression)) {
            const { expression, arguments: args } = child.expression;
            if (expression.getText(file) === "this.context.turnState.hasActiveTurn"
              && args.length === 2
              && args[0]?.getText(file) === threadId
              && args[1]?.getText(file) === ignoreReservation) return true;
          }
          return ts.forEachChild(child, findUnionReturn);
        }) === true;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(mentions).toEqual([]);
  expect(readsUnion).toBe(true);
});
