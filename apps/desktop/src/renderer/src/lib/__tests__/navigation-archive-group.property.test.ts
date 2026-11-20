import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import { readNavigationArchiveGroup } from "../navigation-archive-group";

it("retains diagnostic metadata from the owning instance instead of the viewer's stale row", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.uuid(), async (threadId, path) => {
    const owner: NavigationThreadSummary = {
      id: threadId, source: "codex", title: `Owner ${threadId}`, titleSource: "explicit", inbox: { inInbox: false },
      linkedDirectories: [{ id: "checkout", label: "Project", kind: "worktree",
        path: "/contrived/repository", worktreePath: `/contrived/worktrees/${path}` }],
    };
    const viewer = { ...owner, title: "Stale viewer title", linkedDirectories: [] };
    const members = await readNavigationArchiveGroup({ thread: viewer, api: {
      getNavigationQueryPage: async (request) => navigationQueryFixture(request, { threads: [request.inventory === "owner" ? owner : viewer] }),
    } });
    expect(members[0]).toMatchObject({ id: owner.id, source: owner.source, title: owner.title, linkedDirectories: owner.linkedDirectories });
  }), { numRuns: 25 });
});

it("retains viewer-selected peer threads when their owner names an unloaded intermediate parent", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom<NavigationThreadSummary["source"]>("codex", "claude", "acp:kimi"), async (backend) => {
    const root: NavigationThreadSummary = { id: "root", source: "codex", title: "Root", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false } };
    const ownerChild: NavigationThreadSummary = { ...root, id: "child", source: backend,
      parentThreadId: "unloaded-parent", parentThreadBackend: backend,
      federation: { instanceLabel: "Peer", capabilities: ["turn_control"],
        ref: { backend, threadId: "child", target: { scope: "remote", instanceId: "peer" } } } };
    const viewerChild = { ...ownerChild, parentThreadId: "root", parentThreadBackend: "codex" as const, parentThreadInstanceId: "viewer" };
    const members = await readNavigationArchiveGroup({ thread: root, api: {
      readFederationHealth: async () => ({ health: { instanceId: "viewer", enabled: true, role: "gateway", status: "connected", peers: [] } }),
      getNavigationQueryPage: async (request) => navigationQueryFixture(request, {
        threads: request.inventory === "viewer" ? [root, viewerChild]
          : request.federationTarget?.scope === "remote" ? [ownerChild] : [root],
      }),
    } });
    expect(members.map((member) => member.id)).toEqual(["child", "root"]);
    expect(members[0]?.federationTarget).toEqual({ scope: "remote", instanceId: "peer" });
  }), { numRuns: 25 });
});

it("archives every selected identity once in descendant order across three owners and mixed backends", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    parent: fc.nat(), backend: fc.constantFrom<NavigationThreadSummary["source"]>("codex", "claude", "acp:kimi"),
  }), { minLength: 3, maxLength: 16, size: "max" }), async (nodes) => {
    const owners = ["viewer", "peer-a", "peer-b"];
    const parents = nodes.map((node, index) => index === 0 ? -1 : index === 2 ? 1 : node.parent % index);
    const threads: NavigationThreadSummary[] = nodes.map((node, index) => {
      const owner = owners[index % 3]!;
      const parent = parents[index]!;
      const parentOwner = parent < 0 ? undefined : owners[parent % 3];
      return { id: `thread-${index}`, source: node.backend, title: `Thread ${index}`, titleSource: "explicit",
        linkedDirectories: [], inbox: { inInbox: false },
        ...(parent < 0 ? {} : { parentThreadId: `thread-${parent}`, parentThreadBackend: nodes[parent]!.backend,
          parentThreadInstanceId: parentOwner === owner ? undefined : parentOwner }),
        ...(owner === "viewer" ? {} : { federation: { instanceLabel: owner, capabilities: ["turn_control"],
          ref: { backend: node.backend, threadId: `thread-${index}`, target: { scope: "remote", instanceId: owner } } } }),
      };
    });
    const root = threads[0]!;
    const viewer = threads.map((thread, index) => index === 0 ? thread : { ...thread,
      parentThreadId: root.id, parentThreadBackend: root.source, parentThreadInstanceId: index % 3 === 0 ? undefined : "viewer" });
    const members = await readNavigationArchiveGroup({ thread: root, api: {
      readFederationHealth: async () => ({ health: { instanceId: "viewer", enabled: true, role: "gateway", status: "connected", peers: [] } }),
      getNavigationQueryPage: async (request) => navigationQueryFixture(request, { threads: request.inventory === "viewer" ? viewer
        : threads.filter((_, index) => owners[index % 3] === (request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : "viewer")) }),
    } });
    expect(new Set(members.map((member) => member.id))).toEqual(new Set(threads.map((thread) => thread.id)));
    expect(members).toHaveLength(nodes.length);
    const order = new Map(members.map((member, index) => [member.id, index]));
    for (const [index, parent] of parents.entries()) {
      if (parent >= 0) expect(order.get(`thread-${index}`)!).toBeLessThan(order.get(`thread-${parent}`)!);
      const member = members.find((candidate) => candidate.id === `thread-${index}`)!;
      expect(member.federationTarget).toEqual(index % 3 === 0 ? { scope: "local" } : { scope: "remote", instanceId: owners[index % 3] });
      expect(member.source).toBe(nodes[index]!.backend);
    }
  }), { numRuns: 25 });
});

// The 1 MiB budget measures the plan, so measuring it must cost about one
// encode of the plan. Re-encoding every member on each admitted row made a
// large group quadratic on the renderer thread.
it("checks the planning budget in time linear in the group", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 40, max: 240 }), async (size) => {
    const row = (id: string, parent?: string): NavigationThreadSummary => ({ id, source: "codex", title: `Thread ${id}`,
      titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
      ...(parent ? { parentThreadId: parent, parentThreadBackend: "codex" as const } : {}) });
    const threads = [row("root"), ...Array.from({ length: size }, (_, index) => row(`child-${index}`, "root"))];
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      const members = await readNavigationArchiveGroup({ thread: threads[0]!, api: {
        getNavigationQueryPage: async (request) => navigationQueryFixture(request, { threads }),
      } });
      expect(members).toHaveLength(size + 1);
      const encodedBytes = encode.mock.results.reduce((total, result) => total + (result.value as Uint8Array).byteLength, 0);
      // Each member's identity and owner row together serialize to well under 1 KiB.
      expect(encodedBytes).toBeLessThan((size + 1) * 1024);
    } finally { encode.mockRestore(); }
  }), { numRuns: 6 });
});
