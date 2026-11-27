import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadSessionCache } from "../thread-session-cache";

const keys = Array.from({ length: 16 }, (_, index) => `codex:${index}`);
const idle = { interacted: false, lastTouchedAt: 0 };
const session = fc.record({
  interacted: fc.boolean(),
  lastTouchedAt: fc.integer({ min: 0, max: 3 }),
  thinkingSinceAt: fc.option(fc.nat(3), { nil: undefined }),
  pendingRequest: fc.boolean(),
  pendingUserInput: fc.boolean(),
  staleThinkingRecheckAt: fc.option(fc.nat(3), { nil: undefined }),
}).map((value) => ({
  ...value,
  thinkingSinceAt: value.pendingRequest || value.pendingUserInput ? 0 : value.thinkingSinceAt,
}));
type Session = typeof idle & {
  thinkingSinceAt?: number;
  pendingRequest?: boolean;
  pendingUserInput?: boolean;
  staleThinkingRecheckAt?: number;
};
const key = fc.constantFrom(...keys);
const operation = fc.record({ key, selected: fc.option(key, { nil: undefined }), session, remove: fc.boolean() });

it("matches full retention and indicator projections across updates, selection changes and remote eviction", () => {
  fc.assert(fc.property(fc.array(operation, { minLength: 16, maxLength: 40, size: "max" }), (operations) => {
    const cache = new ThreadSessionCache<Session>();
    let model = new Map<string, Session>();
    // Start at the capacity boundary, with a protected selection and ten tied views.
    for (const id of keys.slice(0, 11)) {
      model.set(id, idle);
      cache.set(id, idle, keys[0], false);
    }
    for (const op of operations) {
      // A renderer may still hold any published snapshot.
      Object.values(cache.getSummary()).forEach(Object.freeze);
      if (op.remove) {
        cache.remove([op.key], op.selected);
        if (op.key !== op.selected) model.delete(op.key);
      } else {
        cache.set(op.key, op.session, op.selected, op.session.thinkingSinceAt !== undefined);
        model.set(op.key, op.session);
        const entries = [...model];
        const protectedKeys = entries.filter(([id, s]) => id === op.selected || s.interacted || s.thinkingSinceAt !== undefined);
        const viewOnly = entries.filter(([id, s]) => id !== op.selected && !s.interacted && s.thinkingSinceAt === undefined);
        model = new Map([...protectedKeys, ...viewOnly.sort((a, b) => b[1].lastTouchedAt - a[1].lastTouchedAt).slice(0, 10)]);
      }
      const summary = cache.getSummary();
      for (const id of keys) {
        const entry = model.get(id);
        if (cache.get(id) !== entry || summary.staleThinkingRechecks[id] !== entry?.staleThinkingRecheckAt
          || summary.thinkingThreadKeys[id] !== (entry?.thinkingSinceAt !== undefined || undefined)
          || summary.approvalRequestThreadKeys[id] !== (entry?.pendingRequest || undefined)
          || summary.inputRequestThreadKeys[id] !== (entry?.pendingUserInput || undefined)) {
          throw new Error("Session or indicator differs from full projection for " + id);
        }
      }
    }
  }));
});

it("keeps the previously selected view ahead of equally recent idle sessions at the cap", () => {
  const cache = new ThreadSessionCache<typeof idle>();
  for (const key of keys.slice(0, 11)) cache.set(key, idle, keys[0], false);
  cache.set(keys[11]!, idle, keys[11], false);
  expect(keys.filter((key) => cache.get(key))).toEqual([...keys.slice(0, 10), keys[11]]);
});

it("streams on one warm thread without revisiting its peers or republishing sidebar membership", () => {
  const cache = new ThreadSessionCache<typeof idle>();
  let reads = 0;
  const peer = { get interacted() { reads++; return true; }, lastTouchedAt: 0 };
  for (const key of keys) cache.set(key, peer, keys[0], true);
  const previous = cache.getSummary();
  reads = 0;
  cache.set(keys[0]!, { interacted: true, lastTouchedAt: 1 }, keys[0], true);
  expect(reads).toBe(0);
  expect(cache.getSummary()).toBe(previous);
});
