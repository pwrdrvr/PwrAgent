import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { notifyEachListener, notifyEachListenerAsync } from "../listeners";

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

describe("notifyEachListenerAsync", () => {
  type Behaviour = "ok" | "throws" | "rejects" | "resolves";

  it("calls every listener, reports each failure, and never rejects", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Behaviour>("ok", "throws", "rejects", "resolves"), { maxLength: 8 }),
        fc.boolean(),
        async (behaviours, loggerThrows) => {
          const called: number[] = [];
          const settled: number[] = [];
          const listeners = behaviours.map((behaviour, index) => (value: string) => {
            expect(value).toBe("event");
            called.push(index);
            if (behaviour === "throws") throw new Error(`listener ${index}`);
            if (behaviour === "rejects") {
              return Promise.reject(new Error(`listener ${index}`));
            }
            if (behaviour === "resolves") {
              return Promise.resolve().then(() => {
                settled.push(index);
              });
            }
            return undefined;
          });
          const unhandled: unknown[] = [];
          const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
          };
          process.on("unhandledRejection", onUnhandled);

          const errors: string[] = [];
          try {
            await notifyEachListenerAsync(listeners, "event", (error) => {
              errors.push((error as Error).message);
              if (loggerThrows) throw new Error("logger failed");
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
          } finally {
            process.off("unhandledRejection", onUnhandled);
          }

          expect(called).toEqual(behaviours.map((_, index) => index));
          // Awaiting the helper waits for every listener's promise.
          expect(settled).toEqual(behaviours.flatMap((b, index) => (b === "resolves" ? [index] : [])));
          expect([...errors].sort()).toEqual(
            behaviours
              .flatMap((b, index) => (b === "throws" || b === "rejects" ? [`listener ${index}`] : []))
              .sort(),
          );
          expect(unhandled).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
