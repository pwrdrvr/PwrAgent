import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { projectSessionIndicatorKeys } from "../session-indicator-keys";

const states = fc.dictionary(fc.string({ maxLength: 18 }).map((id) => `codex:${id}`), fc.boolean(), { maxKeys: 30 });
const include = (session: { active: boolean }) => session.active;

describe("session indicator membership model", () => {
  it("matches the complete owner projection after arbitrary additions, changes and removals", () => {
    fc.assert(fc.property(fc.array(states, { minLength: 1, maxLength: 30 }), (sequence) => {
      let previous: Record<string, boolean> = Object.freeze({});
      for (const values of sequence) {
        const sessions = Object.fromEntries(Object.entries(values).map(([key, active]) => [key, { active }]));
        const expected = Object.fromEntries(Object.entries(values).filter(([, active]) => active));
        const before = { ...previous };
        const next = projectSessionIndicatorKeys(sessions, include, previous);
        expect(next).toEqual(expected);
        expect(previous).toEqual(before);
        if (Object.keys(expected).length === Object.keys(previous).length
          && Object.keys(expected).every((key) => previous[key] === true)) {
          expect(next).toBe(previous);
        } else {
          expect(next).not.toBe(previous);
        }
        previous = Object.freeze(next);
      }
    }), { numRuns: 100 });
  });

  it.each([20, 40])("budgets one scan, N predicate reads and zero record/array construction for %i unchanged sessions", (count) => {
    let scans = 0;
    let reads = 0;
    const sessions = new Proxy(Object.fromEntries(Array.from({ length: count }, (_, index) => [`codex:${index}`, { active: index % 2 === 0 }])), {
      ownKeys: (target) => { scans++; return Reflect.ownKeys(target); },
      get: (target, key, receiver) => { reads++; return Reflect.get(target, key, receiver); },
    });
    const previous = Object.freeze(Object.fromEntries(Array.from({ length: count / 2 }, (_, index) => [`codex:${index * 2}`, true])));
    const predicate = vi.fn(include);
    const entries = vi.spyOn(Object, "entries");
    const fromEntries = vi.spyOn(Object, "fromEntries");
    try {
      const result = projectSessionIndicatorKeys(sessions, predicate, previous);
      expect({ scans, reads, predicates: predicate.mock.calls.length,
        recordAllocations: Number(result !== previous), entriesArrays: entries.mock.calls.length,
        recordsFromArrays: fromEntries.mock.calls.length,
      }).toEqual({ scans: 1, reads: count, predicates: count, recordAllocations: 0, entriesArrays: 0, recordsFromArrays: 0 });
    } finally { entries.mockRestore(); fromEntries.mockRestore(); }
  });
});
