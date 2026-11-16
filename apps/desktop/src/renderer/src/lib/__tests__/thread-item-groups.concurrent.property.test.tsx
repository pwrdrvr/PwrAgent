import { Suspense, type ReactNode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import fc from "fast-check";
import { useThreadItemGroups } from "../thread-item-groups";

afterEach(cleanup);
const owner = (item: { id: number }) => item.id >= 0 ? "thread" : "other";

it("retains committed groups when generated speculative projections suspend", () => {
  fc.assert(fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 5, size: "max" }), (ids) => {
    const first = { id: 0 };
    const never = new Promise<void>(() => {});
    const wrapper = ({ children }: { children: ReactNode }) => <Suspense fallback={null}>{children}</Suspense>;
    const hook = renderHook(({ items, suspend }) => {
      const groups = useThreadItemGroups(items, owner, Object.is);
      if (suspend) throw never;
      return groups;
    }, { initialProps: { items: [first], suspend: false }, wrapper });
    try {
      const committed = hook.result.current;
      for (const id of ids) {
        hook.rerender({ items: [first, { id }], suspend: true });
        hook.rerender({ items: [first], suspend: false });
        expect(hook.result.current).toBe(committed);
      }
    } finally { hook.unmount(); }
  }), { numRuns: 15 });
});
