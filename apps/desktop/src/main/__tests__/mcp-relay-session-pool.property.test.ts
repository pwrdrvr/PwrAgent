import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RelaySessionPool } from "../mcp-connections/mcp-relay-session-pool";

type Session = { id: number };

type Command =
  | { kind: "call"; token: number }
  | { kind: "finish"; pick: number }
  | { kind: "list" }
  | { kind: "end"; pick: number };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant("call" as const), token: fc.integer({ min: 0, max: 5 }) }),
  fc.record({ kind: fc.constant("finish" as const), pick: fc.nat() }),
  fc.constant({ kind: "list" as const }),
  fc.record({ kind: fc.constant("end" as const), pick: fc.nat() }),
);

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("RelaySessionPool", () => {
  it("never shares a running tool call's session, and opens only when every session is busy", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.array(command, { maxLength: 40 }), async (max, commands) => {
      let opened = 0;
      const closed = new Set<Session>();
      const ended = new Set<number>();
      const pool = new RelaySessionPool<Session>({
        open: async () => ({ id: opened++ }),
        close: async (session) => { closed.add(session); },
        max,
      });
      // The model: calls that hold a session, and calls still waiting for one.
      const running: Array<{ token: string; session: Session; release: () => void }> = [];
      const waiting: Array<{ token: string; result?: { session: Session; release: () => void } }> = [];
      let callId = 0;

      for (const step of commands) {
        const before = pool.size;
        const idleBefore = pool.list().filter((session) => pool.holderOf(session) === undefined).length;
        if (step.kind === "call") {
          const entry: (typeof waiting)[number] = { token: `t${step.token}-${callId++}` };
          waiting.push(entry);
          // A call still waiting when the pool closes fails; the model ends there.
          void pool.exclusive(entry.token).then((result) => { entry.result = result; }, () => undefined);
          await settle();
          // A call opens a session only when none is idle, and never past max.
          if (idleBefore > 0) expect(pool.size).toBe(before);
          else if (before < max) expect(pool.size).toBe(before + 1);
          else expect(pool.size).toBe(before);
        } else if (step.kind === "finish" && running.length > 0) {
          const [call] = running.splice(step.pick % running.length, 1);
          call!.release();
          await settle();
        } else if (step.kind === "list") {
          const session = await pool.shared();
          // A listing opens a session only for an empty pool, and always uses
          // the first, so a subscription and its undoing reach one session.
          expect(pool.size).toBe(before === 0 ? 1 : before);
          expect(session).toBe(pool.list()[0]);
        } else if (step.kind === "end" && pool.size > 0) {
          // The app ended one session; the call that held it has failed.
          const session = pool.list()[step.pick % pool.size]!;
          pool.remove(session);
          ended.add(session.id);
          const index = running.findIndex((call) => call.session === session);
          if (index >= 0) running.splice(index, 1)[0]!.release();
          await settle();
        }
        for (let index = waiting.length - 1; index >= 0; index -= 1) {
          const entry = waiting[index]!;
          if (entry.result === undefined) continue;
          waiting.splice(index, 1);
          running.push({ token: entry.token, ...entry.result });
        }

        expect(pool.size).toBeLessThanOrEqual(max);
        // Each running call has a session of its own, and the pool knows who holds it.
        expect(new Set(running.map((call) => call.session)).size).toBe(running.length);
        for (const call of running) expect(pool.holderOf(call.session)).toBe(call.token);
        // No call waits while a session sits idle or the pool has room.
        const idle = pool.list().filter((session) => pool.holderOf(session) === undefined).length;
        if (waiting.length > 0) {
          expect(idle).toBe(0);
          expect(pool.size).toBe(max);
        }
      }

      await pool.close();
      await settle();
      expect(pool.size).toBe(0);
      // Closing the pool closes every session it still had; none leaks.
      for (let id = 0; id < opened; id += 1) {
        expect([...closed].some((session) => session.id === id) || ended.has(id)).toBe(true);
      }
    }), { numRuns: 200 });
  });

  it("rejects the calls still waiting when the pool closes", async () => {
    const pool = new RelaySessionPool<Session>({
      open: async () => ({ id: 0 }),
      close: async () => undefined,
      max: 1,
    });
    const first = await pool.exclusive("a");
    const second = pool.exclusive("b");
    await settle();
    await pool.close();
    await expect(second).rejects.toThrow("Retry discovery");
    first.release();
  });

  it("closes a session that finishes opening after the pool closed", async () => {
    let finish!: (session: Session) => void;
    const closed: Session[] = [];
    const pool = new RelaySessionPool<Session>({
      open: async () => await new Promise<Session>((resolve) => { finish = resolve; }),
      close: async (session) => { closed.push(session); },
      max: 2,
    });
    const listing = pool.shared();
    await settle();
    await pool.close();
    await expect(listing).rejects.toThrow("Retry discovery");
    const late = { id: 7 };
    finish(late);
    await settle();
    expect(closed).toEqual([late]);
  });
});
