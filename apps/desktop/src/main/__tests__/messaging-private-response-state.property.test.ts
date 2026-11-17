import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MessagingPrivateResponses, transitionPrivateResponse, type PrivateResponseReceipt } from "../messaging/core/messaging-private-response-state";

type Operation = "register" | "hold" | "fallback" | "tool" | "deliver" | "finish" | "retire" | "dispose";
type Attempt = { receipt?: PrivateResponseReceipt; visible: boolean; open: boolean };
type Session = { live: boolean; completion: boolean; privateRequested: boolean; withheld: boolean; fallbackTaken: boolean; held?: string; attempts: Attempt[] };
type Model = { stopped: boolean; sessions: Map<string, Session> };
type Real = MessagingPrivateResponses;

// This model records protocol facts (admission, requests and provider receipts),
// rather than copying the reducer's phases. Its projection is source privacy,
// visible delivery, pending effects, held body and continuation routing.
class ResponseCommand implements fc.Command<Model, Real> {
  constructor(private readonly operation: Operation, private readonly key: string, private readonly flag: boolean) {}

  check(model: Readonly<Model>): boolean {
    const session = model.sessions.get(this.key);
    if (this.operation === "dispose") return !model.stopped;
    if (model.stopped) return true; // Late effects must not resurrect disposed state.
    if (this.operation === "register") return !session;
    if (!session) return false;
    if (this.operation === "deliver" || this.operation === "finish") return session.attempts.some(attempt => attempt.open);
    if (this.operation === "hold" || this.operation === "tool") return session.live;
    return true; // Replayed fallback/terminal evidence is valid.
  }

  run(model: Model, real: Real): void {
    const session = model.sessions.get(this.key);
    switch (this.operation) {
      case "register":
        real.register(this.key, { fallback: this.flag, replyCompletion: this.flag });
        if (!model.stopped) model.sessions.set(this.key, { live: true, completion: this.flag, privateRequested: this.flag, withheld: this.flag, fallbackTaken: false, attempts: [] });
        break;
      case "hold":
        real.hold(this.key, "Fixture held answer");
        if (!model.stopped && session!.privateRequested && !session!.fallbackTaken && session!.attempts.length === 0) session!.held = "Fixture held answer";
        break;
      case "fallback": {
        const allowed = !model.stopped && session!.privateRequested && !session!.fallbackTaken && session!.attempts.length === 0;
        expect(real.claimFallback(this.key)).toBe(allowed);
        if (allowed) {
          session!.fallbackTaken = true;
          session!.held = undefined;
          session!.attempts.push({ receipt: real.beginTool(this.key), visible: false, open: true });
        }
        break;
      }
      case "tool": {
        const receipt = real.beginTool(this.key);
        if (!model.stopped) {
          if (!session!.attempts.some(attempt => attempt.open) || !session!.fallbackTaken) session!.withheld = false;
          session!.held = undefined;
          session!.attempts.push({ receipt, visible: false, open: true });
        }
        break;
      }
      case "deliver": {
        const attempt = session?.attempts.find(candidate => candidate.open);
        real.delivered(attempt?.receipt);
        if (!model.stopped) { attempt!.visible = true; session!.withheld = false; }
        break;
      }
      case "finish": {
        const attempt = session?.attempts.find(candidate => candidate.open);
        real.finishTool(attempt?.receipt);
        if (!model.stopped) attempt!.open = false;
        break;
      }
      case "retire":
        real.retire(this.key);
        if (!model.stopped) { session!.live = false; session!.completion = false; }
        break;
      case "dispose": real.dispose(); model.stopped = true; break;
    }
    for (const [key, expected] of model.sessions) {
      if (model.stopped) { expect(real.state(key)).toBeUndefined(); continue; }
      expect(real.isTerminal(key)).toBe(expected.attempts.some(attempt => attempt.visible));
      expect(real.isFallback(key)).toBe(expected.withheld);
      expect(real.heldText(key)).toBe(expected.held);
      expect(real.state(key)?.replyCompletion).toBe(expected.completion);
      expect(real.state(key)?.pending).toBe(expected.attempts.filter(attempt => attempt.open).length);
    }
  }

  toString(): string { return `${this.operation}(${this.key}, ${this.flag})`; }
}

describe("private-response state protocol", () => {
  it("matches valid generated sessions, retries, overlapping receipts, repeated evidence and shutdown", () => {
    const commands = fc.commands([fc.tuple(
      fc.constantFrom<Operation>("register", "hold", "fallback", "tool", "deliver", "finish", "retire", "dispose"),
      fc.integer({ min: 0, max: 2 }), fc.boolean(),
    ).map(([operation, key, flag]) => new ResponseCommand(operation, `turn-${key}`, flag))], { maxCommands: 35, size: "max" });
    fc.assert(fc.property(commands, sequence => {
      fc.modelRun(() => ({ model: { sessions: new Map(), stopped: false }, real: new MessagingPrivateResponses() }), sequence);
    }));
  });

  it("retains live delivery evidence and pending effects while evicting settled history at the real bound", () => {
    const real = new MessagingPrivateResponses();
    real.register("old-live", { fallback: true, replyCompletion: false });
    expect(real.claimFallback("old-live")).toBe(true);
    const live = real.beginTool("old-live");
    real.delivered(live);
    const pending = real.beginTool("retired-pending");
    real.retire("retired-pending");
    for (let n = 0; n < 1_001; n += 1) {
      real.register(`history-${n}`, { fallback: true, replyCompletion: true });
      real.retire(`history-${n}`);
    }
    expect(real.state("history-0")).toBeUndefined();
    expect(real.state("history-1")).toBeDefined();
    expect(real.state("old-live")?.status).toBe("terminal");
    expect(real.claimFallback("old-live")).toBe(false);
    expect(real.claimFallback("history-0")).toBe(false);
    expect(real.state("retired-pending")?.pending).toBe(1);
    real.delivered(pending);
    real.finishTool(pending);
    expect(real.state("retired-pending")?.status).toBe("terminal");
    expect(real.state("history-1")).toBeUndefined();
    expect(real.state("history-2")).toBeDefined();
    real.finishTool(live);
    expect(real.isTerminal("old-live")).toBe(true);
    const retry = real.beginTool("old-live");
    expect(real.isTerminal("old-live"), "a later explicit retry cannot erase visible delivery evidence").toBe(true);
    real.finishTool(retry);
    expect(real.isTerminal("old-live")).toBe(true);
  });

  it("evicts held payloads in first-hold order at 256 without forgetting fallback ownership", () => {
    const real = new MessagingPrivateResponses();
    for (let n = 0; n < 258; n += 1) real.register(`turn-${n}`, { fallback: true, replyCompletion: false });
    for (let n = 257; n >= 0; n -= 1) real.hold(`turn-${n}`, `Body ${n}`);
    expect(real.heldText("turn-257")).toBeUndefined();
    expect(real.heldText("turn-256")).toBeUndefined();
    expect(real.heldText("turn-255")).toBe("Body 255");
    expect(real.isFallback("turn-257")).toBe(true);
    expect(real.claimFallback("turn-257")).toBe(true);
  });

  it("makes cleanup and eviction explicit reducer effects", () => {
    const admitted = transitionPrivateResponse(undefined, { type: "register", fallback: true, replyCompletion: true }).state!;
    expect(transitionPrivateResponse(admitted, { type: "evict" })).toEqual({ state: admitted, effects: [] });
    const retired = transitionPrivateResponse(admitted, { type: "retire" }).state!;
    expect(transitionPrivateResponse(retired, { type: "evict" })).toEqual({ state: undefined, effects: ["remove"] });
    const pending = transitionPrivateResponse(retired, { type: "beginTool", lifetime: "settled" }).state!;
    expect(transitionPrivateResponse(pending, { type: "evict" })).toEqual({ state: pending, effects: [] });
    expect(transitionPrivateResponse(admitted, { type: "dispose" })).toEqual({ state: undefined, effects: ["remove"] });
  });

  it("never reclaims a failed fallback, including after repeated terminal evidence", () => {
    const real = new MessagingPrivateResponses();
    real.register("failed", { fallback: true, replyCompletion: false });
    expect(real.claimFallback("failed")).toBe(true);
    const receipt = real.beginTool("failed");
    real.finishTool(receipt);
    expect(real.isFallback("failed")).toBe(true);
    expect(real.claimFallback("failed")).toBe(false);
    real.retire("failed");
    real.retire("failed");
    expect(real.claimFallback("failed")).toBe(false);
  });

  it("rejects an old delivery receipt after history eviction and a new attempt with the same key", () => {
    const real = new MessagingPrivateResponses();
    const old = real.beginTool("replayed-key");
    real.finishTool(old);
    for (let n = 0; n < 1_000; n += 1) {
      const receipt = real.beginTool(`history-${n}`);
      real.finishTool(receipt);
    }
    expect(real.state("replayed-key")).toBeUndefined();
    const current = real.beginTool("replayed-key");
    real.delivered(old);
    real.finishTool(old);
    expect(real.isTerminal("replayed-key")).toBe(false);
    expect(real.state("replayed-key")?.pending).toBe(1);
    real.delivered(current);
    expect(real.isTerminal("replayed-key")).toBe(true);
  });
});
