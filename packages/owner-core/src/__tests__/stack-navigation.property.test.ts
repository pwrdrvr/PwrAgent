import fc from "fast-check";
import { expect, it } from "vitest";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES, type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { parseGhStackCatalog } from "@pwragent/shared/stacks/catalog";
import { compactStackMembership, type StackSummary } from "@pwragent/shared/stacks/stack-status";
import { createNavigationQuerySnapshot, projectNavigationQuery } from "../navigation-query-projection";

it("keeps stack-membership rows bounded and their total wire size linear at the catalog admission limit", () => {
  fc.assert(fc.property(fc.integer({ min: 512, max: 900 }), fc.constantFrom("a", "💡", "a\""), (count, letters) => {
    const prefix = letters.repeat(Math.floor((1024 * 1024 - 32_768) / count / Buffer.byteLength(JSON.stringify(letters).slice(1, -1))));
    const branches = Array.from({ length: count }, (_, index) => ({ branch: `${prefix}${index}` }));
    const catalog = { schemaVersion: 1, repository: "github.com:fixture/project",
      stacks: [{ trunk: { branch: "main" }, branches }] };
    const catalogBytes = Buffer.byteLength(JSON.stringify(catalog));
    expect(catalogBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(catalogBytes).toBeGreaterThan(920 * 1024);
    expect(parseGhStackCatalog(JSON.stringify(catalog)).status).toBe("ok");

    const stack: StackSummary = { key: "fixture-stack", name: branches[0]!.branch, inferred: false,
      repository: catalog.repository, trunk: "main",
      layers: branches.map(({ branch }, index) => ({
        branch, parent: branches[index - 1]?.branch ?? "main", health: "in_sync", role: "layer",
        thread: { key: `codex:thread-${index}`, title: `Thread ${index}` },
      })) };
    const threads: NavigationThreadSummary[] = stack.layers.map((layer, index) => ({
      id: `thread-${index}`, source: "codex", title: layer.thread!.title, titleSource: "derived",
      linkedDirectories: [], inbox: { inInbox: false },
      // Also pins conversion when a new owner projects an older peer's rows.
      ...(index === 0 ? { stacks: [{ stack, position: 1 }] }
        : { stackMemberships: [compactStackMembership(stack, index + 1)!] }),
    }));
    const index = createNavigationQuerySnapshot({ directories: [], threads, localInstanceId: "fixture-owner" });
    let bytes = 0;
    for (let offset = 0; offset < threads.length; offset += 10) {
      const projection = projectNavigationQuery({ index, request: {
        protocol: 2, consumer: "main-sidebar", inventory: "owner",
        query: { kind: "exact", identities: threads.slice(offset, offset + 10).map((thread) => ({
          backend: thread.source, threadId: thread.id,
        })) },
      } });
      const pageBytes = Buffer.byteLength(JSON.stringify(projection.entries));
      expect(projection.entries).toHaveLength(Math.min(10, threads.length - offset));
      expect(pageBytes).toBeLessThan(NAVIGATION_QUERY_MAX_RESULT_BYTES);
      expect(projection.entries[0]?.row).toMatchObject({
        stackMemberships: [{ position: offset + 1, count, key: "fixture-stack" }],
      });
      expect(projection.entries[0]?.row.stacks).toBeUndefined();
      bytes += pageBytes;
    }
    expect(bytes).toBeLessThan(4096 * count);
  }), { numRuns: 6, examples: [[900, "💡"]] });
});
