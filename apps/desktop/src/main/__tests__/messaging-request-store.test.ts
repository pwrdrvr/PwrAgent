import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagingInboundEvent } from "@pwragent/messaging-interface";
import { SqliteMessagingRequestStore } from "../state/messaging-request-store";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir, openInMemoryStateDb } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { mergeCausalMessagingContext } from "../app-server/causal-messaging-context";

const databases: StateDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllEnvs(); resetSqliteWriteMetrics(); });
const agent = { backend: "codex" as const, threadId: "manager" };
function event(id: string, channel = "C4", receivedAt = 1000): MessagingInboundEvent {
  return {
    id, kind: "text", text: "Private original instructions", receivedAt,
    actor: { platformUserId: "U1" },
    channel: { channel: "slack", conversation: { id: channel, kind: "channel", workspaceId: "T1" } },
    routingState: { opaque: { channelId: channel, ts: "1000.000001", token: "never-retain-this" } },
  };
}
function fixture() {
  const db = openInMemoryStateDb(); databases.push(db);
  return { db, store: new SqliteMessagingRequestStore(db.raw) };
}

describe("causal messaging request persistence", () => {
  it("keeps the original channel4 anchor while newest-human summaries advance independently", () => {
    const { store } = fixture();
    const source = store.remember({ agent, event: event("root") })!;
    for (const channel of ["C1", "C2", "C3", "C5"]) store.remember({ agent, event: event(channel, channel, 2000) });
    store.remember({ agent, event: event("newer-channel4", "C4", 3000) });
    expect(store.get(source.ref)).toEqual(source);
    expect(store.get(source.ref)?.event.receivedAt).toBe(1000);
    expect(store.list(source, 25).map((s) => s.event.receivedAt)).toEqual([3000, 2000, 2000, 2000, 2000]);
    expect(store.destination(source, source.selector)?.ref.requestId).not.toBe(source.ref.requestId);
    expect(JSON.stringify(source)).not.toContain("Private original instructions");
    expect(JSON.stringify(source)).not.toContain("never-retain-this");
  });

  it("isolates actor, Agent, workspace, thread root and profile identities", () => {
    const { store } = fixture();
    const source = store.remember({ agent, event: event("root") })!;
    const otherActor = event("other"); otherActor.actor.platformUserId = "U2";
    const otherWorkspace = event("other-workspace"); otherWorkspace.channel.conversation.workspaceId = "T2";
    const otherRoot = event("other-root"); otherRoot.channel.conversation.kind = "thread";
    otherRoot.channel.conversation.parentId = "999.000001";
    const actorsSource = store.remember({ agent, event: otherActor })!;
    const agentsSource = store.remember({ agent: { ...agent, threadId: "other-manager" }, event: event("other-agent") })!;
    store.remember({ agent, event: otherWorkspace }); store.remember({ agent, event: otherRoot });
    expect(store.destination(source, actorsSource.selector)).toBeUndefined();
    expect(store.destination(source, agentsSource.selector)).toBeUndefined();
    expect(store.list(source, 25)).toHaveLength(3);
    expect(fixture().store.get(source.ref)).toBeUndefined();
  });

  it("preserves Telegram parent identity and ignores bot/passive/lifecycle events and duplicate deliveries", () => {
    const { store } = fixture();
    const a = event("topic"); a.channel = { channel: "telegram", conversation: { id: "4", kind: "topic", parentId: "-1001", parentConversationId: "-1001" } };
    const b = structuredClone(a); b.channel.conversation.parentId = "-1002"; b.channel.conversation.parentConversationId = "-1002";
    const source = store.remember({ agent, event: a })!;
    expect(store.remember({ agent, event: b })?.selector).not.toBe(source.selector);
    expect(store.remember({ agent, event: { ...a, receivedAt: 9000 } })).toEqual(source);
    expect(store.remember({ agent, event: { ...a, id: "bot", actor: { ...a.actor, isBot: true } } })).toBeUndefined();
    expect(store.remember({ agent, event: { ...a, id: "observed", observedOnly: true } })).toBeUndefined();
    expect(store.remember({ agent, event: { ...source.event, id: "completion", receivedAt: 10000 } })).toBeUndefined();
    expect(store.destination(source, source.selector)?.event.receivedAt).toBe(1000);
  });

  it.each([10, 10000])("uses bounded indexed lookups with %i unrelated historical requests", (count) => {
    const { db, store } = fixture();
    const source = store.remember({ agent, event: event("root") })!;
    db.raw.transaction(() => {
      for (let i = 0; i < count; i++) store.remember({ agent, event: event(`history-${i}`, "C4", 2000 + i) });
    })();
    const prepare = vi.spyOn(db.raw, "prepare");
    expect(store.get(source.ref)).toEqual(source);
    expect(store.list(source, 25)).toHaveLength(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls.every(([sql]) => !sql.includes("OFFSET") && !sql.includes("thread_message_origins"))).toBe(true);
    prepare.mockRestore();
    const plans = db.raw.prepare("EXPLAIN QUERY PLAN SELECT payload FROM messaging_requests WHERE request_id = ?").all(source.ref.requestId) as { detail: string }[];
    expect(plans.some((p) => p.detail.includes("SEARCH") && p.detail.includes("INDEX"))).toBe(true);
    const refs = Array.from({ length: 100 }, () => ({ kind: "agent" as const, causalMessagingSource: source.ref }));
    expect(JSON.stringify(mergeCausalMessagingContext(refs)).length).toBeLessThan(400);
  });

  it("survives reopening without a history scan, backfill or an expanding ancestry payload", () => {
    const f = createTempStateDb("pwragent-messaging-source-");
    let db = StateDb.open(f.dbPath);
    const source = new SqliteMessagingRequestStore(db.raw).remember({ agent, event: event("root") })!;
    db.close();
    db = StateDb.open(f.dbPath);
    try { expect(new SqliteMessagingRequestStore(db.raw).get(source.ref)).toEqual(source); }
    finally { db.close(); removeTempStateDbDir(f.tempDir); }
  });

  it("does not let mixed principals/surfaces acquire the last sender's authority", () => {
    const source = { ownerId: "profile", requestId: "request4", surfaceSelector: "channel4" };
    expect(mergeCausalMessagingContext([{ kind: "agent", causalMessagingSource: source },
      { kind: "agent", causalMessagingSource: { ...source, requestId: "request1", surfaceSelector: "channel1" } }]))
      .toEqual({ causalMessagingSource: undefined, causalMessagingAmbiguous: true });
    expect(mergeCausalMessagingContext([{ kind: "agent", causalMessagingSource: source }, { kind: "agent" }]).causalMessagingAmbiguous).toBe(true);
    expect(mergeCausalMessagingContext([{ kind: "agent", causalMessagingSource: source },
      { kind: "agent", causalMessagingSource: source }]).causalMessagingSource).toEqual(source);
  });

  it("budgets one human boundary and one attachment, with zero writes for duplicate/bot/read retries", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const f = createTempStateDb("pwragent-messaging-source-writes-");
    const db = StateDb.open(f.dbPath);
    const store = new SqliteMessagingRequestStore(db.raw);
    try {
      const { writes } = await measureSqliteWrites(async () => {
        const source = store.remember({ agent, event: event("root") })!;
        const claim = store.claimAttachment([source.ref.requestId, "target"]);
        expect(claim.claimed).toBe(true);
        store.finishAttachment(claim.id, { ok: false, error: { code: "unsupported_operation", message: "fixture outcome" } });
        for (let i = 0; i < 100; i++) {
          store.remember({ agent, event: event("root") });
          store.remember({ agent, event: { ...event(`bot-${i}`), actor: { platformUserId: "bot", isBot: true } } });
          expect(store.claimAttachment([source.ref.requestId, "target"]).claimed).toBe(false);
          store.get(source.ref); store.destination(source, source.selector); store.list(source, 25);
        }
      });
      expectSqliteWriteBudget({ scenario: "messaging-causal-request-and-attachment", writes,
        note: "One accepted human request (immutable source plus latest-human pointer in one transaction), one attachment claim/outcome, 100 duplicate/bot/read retries. No stream, poll or idle writes." });
    } finally { db.close(); removeTempStateDbDir(f.tempDir); }
  });
});
