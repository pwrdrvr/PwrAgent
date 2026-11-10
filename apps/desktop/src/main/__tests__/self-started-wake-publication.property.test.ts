import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { publishSelfStartedWakes } from "../../../e2e/fixtures/self-started-wake-publication";

it("the real SDK wake publisher never replaces a file its peer can already read", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    source: fc.constantFrom("system", "loop_wakeup", "schedule_wakeup"), prompt: fc.string({ maxLength: 40 }),
  }), { minLength: 2, maxLength: 8 }), async wakes => {
    const temporary = new Map<string, string>();
    const published = new Map<string, string>();
    // Windows can deny replacement while the CLI owns an open read of a
    // published file. Every prior publication remains owned by that peer.
    const files = {
      writeFile: async (file: string, content: string) => { temporary.set(file, content); },
      rename: async (source: string, destination: string) => {
        if (published.has(destination)) throw Object.assign(new Error("Reader owns published wake: EPERM"), { code: "EPERM" });
        expect(temporary.has(source)).toBe(true);
        published.set(destination, temporary.get(source)!);
        temporary.delete(source);
      },
    };
    for (let count = 1; count <= wakes.length; count++) {
      await publishSelfStartedWakes(path.join("fixture", "owner"), wakes.slice(0, count), files);
      expect(published.size).toBe(count);
      expect([...published.values()].flatMap(content => JSON.parse(content))).toEqual(wakes.slice(0, count));
      expect(temporary.size).toBe(0);
    }
  }));
});
