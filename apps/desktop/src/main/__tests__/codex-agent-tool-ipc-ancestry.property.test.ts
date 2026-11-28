import fc from "fast-check";
import { expect, it } from "vitest";
import { matchesCodexRelayAncestry } from "../agent-tools/codex-agent-tool-ipc";

it("requires the exact pinned process identity within four parent hops", () => {
  // A reused numeric PID and the connector's own PID grant no authority.
  fc.assert(fc.property(
    fc.uniqueArray(fc.integer({ min: 2, max: 20_000 }), { minLength: 6, maxLength: 6 }),
    fc.integer({ min: 0, max: 5 }),
    fc.integer({ min: 1, max: 100 }),
    (pids, hops, generation) => {
      const root = `${pids[hops]}:${generation}`;
      const observed = pids.map((pid) => `${pid}:${generation}`);
      expect(matchesCodexRelayAncestry(root, observed.slice(0, 5))).toBe(hops >= 1 && hops <= 4);
      expect(matchesCodexRelayAncestry(`${pids[hops]}:${generation + 1}`, observed.slice(0, 5))).toBe(false);
      expect(matchesCodexRelayAncestry(root, observed)).toBe(false);
    },
  ));
});
