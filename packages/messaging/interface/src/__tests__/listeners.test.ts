import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { notifyEachListener } from "../listeners";

describe("notifyEachListener", () => {
  it("calls every listener that does not throw, in order, whichever ones throw", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 8 }), (throws) => {
        const called: number[] = [];
        const listeners = throws.map((shouldThrow, index) => (value: string) => {
          expect(value).toBe("info");
          called.push(index);
          if (shouldThrow) throw new Error(`listener ${index}`);
        });

        const errors: unknown[] = [];
        expect(() => notifyEachListener(listeners, "info", (error) => {
          errors.push(error);
          throw new Error("logger failed");
        })).not.toThrow();
        expect(called).toEqual(throws.map((_, index) => index));
        expect(errors.map((error) => (error as Error).message)).toEqual(
          throws.flatMap((shouldThrow, index) => (shouldThrow ? [`listener ${index}`] : [])),
        );
      }),
    );
  });
});
