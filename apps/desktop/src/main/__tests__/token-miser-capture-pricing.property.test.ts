import { emptyTokenMiserGateAccountingTotals } from "@pwragent/shared/token-miser-savings-summary";
import type { PricingDecision, PricingHistoryPage } from "@pwragent/shared/thread-pricing-display";
import type { ThreadToolInvocationRecord } from "@pwragent/shared/contracts/normalized-app-server";
import { expect, it } from "vitest";
import { TokenMiserPricingPage } from "../app-server/token-miser-pricing-page";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import type { TokenMiserObjectMetadata } from "../token-miser/token-miser-types";

const threadId = "parent";
const turnId = "turn";

function fixture() {
  type Metadata = NonNullable<ReturnType<TokenMiserStore["watchPricingMetadata"]>>;
  type Row = NonNullable<ReturnType<Metadata["get"]>>;
  const rows = new Map<string, Row>();
  const invocations: ThreadToolInvocationRecord[] = [];
  let notify: (id: string) => void;
  let nextRow = 0;
  let visits = 0;
  let loaded = 0;
  let priced = 0;
  const store = {
    watchPricingMetadata: (_thread: string, changed: (id: string) => void): Metadata => {
      notify = changed;
      return {
        dataVersion: () => 1,
        observationCount: () => 0,
        all: () => { loaded += rows.size; return [...rows.values()]; },
        get: (id) => { loaded++; return rows.get(id); },
        close: () => {},
      };
    },
  } satisfies Pick<TokenMiserStore, "watchPricingMetadata">;
  // Only the metadata watcher is external to the production Pricing projection.
  const pricing = TokenMiserPricingPage.open(store as TokenMiserStore, threadId, "codex")!;
  const indexed = (pricing as unknown as { rows: Map<string, { decision?: PricingDecision }> }).rows;

  function write(id: string, source: "capture" | "legacy" | "gate") {
    const rowid = ++nextRow;
    const disposition = rowid % 2 ? "summarized" : "passed_through";
    const entry: TokenMiserObjectMetadata = {
      version: 1, objectId: id, threadId, turnId, toolUseId: id, createdAt: rowid,
      toolName: source === "capture" ? "capture_token_miser_command" : "commandExecution",
      originalCharacters: 400, baselineParentTokens: 100, replacementCharacters: 40, retrievedCharacters: 0,
      summary: { summary: "Fixture", usefulDetails: [] },
      ...(source === "capture" ? { captureBackend: "codex" } : { disposition }),
      ...(source === "gate" ? { replayTrackingVersion: 2 } : {}),
    };
    rows.set(id, { entry, rowid, createdAt: rowid });
    notify(id);
  }

  function advanceInvocation() {
    const id = "invocation-" + invocations.length;
    invocations.push({
      invocationId: id, itemId: id, backend: "codex", threadId, turnId, observedAt: invocations.length,
      toolName: "commandExecution", category: "search", status: "completed", updatedAt: invocations.length,
      outputChars: 0, outputLines: 0, estimatedOutputTokens: 0, warningLines: 0, errorLines: 0,
      infoLines: 0, debugLines: 0, outputTruncated: false, noisy: false,
    });
  }

  function expand(defer = false) {
    const page = {
      revision: "",
      groups: new Map([["parent-line", { orphan: false, parentTurnId: turnId, summary: {}, gates: [] }]]),
    } as unknown as PricingHistoryPage;
    visits = loaded = priced = 0;
    pricing.project(page, emptyTokenMiserGateAccountingTotals(), {
      gate: () => undefined, parent: () => { priced++; return undefined; }, auxiliaryHelperCost: () => 0,
      invocations: () => invocations,
    }, defer);
    const group = page.groups!.get("parent-line")!;
    return { decisions: group.decisions ?? [], count: group.summary.count ?? 0,
      avoided: page.savings?.summary?.avoidedParentTokens, visits, loaded, priced };
  }

  function countCaptureVisits() {
    // Count work on already-folded rows, which is invisible to SQLite read counters.
    for (const row of rows.values()) {
      if (!row.entry.captureBackend) continue;
      const indexedRow = indexed.get(row.entry.objectId)!;
      if (!Object.getOwnPropertyDescriptor(indexedRow, "decision")?.get) {
        Object.defineProperty(indexedRow, "decision", { get: () => { visits++; return undefined; } });
      }
    }
  }

  function expectedDecisions() {
    return [...rows.values()].reverse().filter(({ entry }) => !entry.captureBackend).map(({ entry }) => ({
      disposition: entry.disposition,
      decisionSource: entry.disposition === "passed_through" ? "policy" : undefined,
    }));
  }

  return { write, expand, countCaptureVisits, advanceInvocation, expectedDecisions, close: () => pricing.close() };
}

it("expands a gate group without visiting captures in the same turn", () => {
  const f = fixture();
  try {
    f.write("gate", "gate");
    f.write("capture", "capture");
    f.expand();
    f.countCaptureVisits();
    expect(f.expand()).toEqual({ decisions: f.expectedDecisions(), count: 1, avoided: 180, visits: 0, loaded: 0, priced: 0 });
  } finally {
    f.close();
  }
});

it("refreshes a legacy replay without visiting captures in the same turn", () => {
  const f = fixture();
  try {
    f.write("legacy", "legacy");
    f.write("capture", "capture");
    f.expand(true);
    f.countCaptureVisits();
    f.advanceInvocation();
    expect(f.expand(true)).toEqual({ decisions: [], count: 1, avoided: 180, visits: 0, loaded: 0, priced: 1 });
  } finally {
    f.close();
  }
});
