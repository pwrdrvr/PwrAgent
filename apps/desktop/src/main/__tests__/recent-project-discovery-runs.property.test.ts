import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  DiscoverRecentProjectsResponse,
  RecentProjectDiscoveryPart,
} from "@pwragent/shared/contracts/settings";
import type { RecentClaudeCodeDirectories } from "../claude/claude-recent-projects";
import {
  discoverRecentProjects,
  readRecentCodexDirectories,
  RecentProjectDiscoveryRuns,
  type RecentCodexDirectories,
  type RecentCodexDirectoryClient,
} from "../onboarding/recent-project-discovery";

/*
 * Rule: for each part of Get started's project search, a window has at most
 * one read open, and it belongs to that window's newest request for that
 * part. The agents part's read is a Codex App Server; the Claude Code
 * history part's is an SDK read. A request the window replaced stops its
 * read at once rather than paging to the end. Asking for one part never
 * stops the other part's read, and a window that closes has none open.
 * Other windows' searches are untouched.
 *
 * Model: per window and part, the newest request still wanted. Commands: a
 * window asks for a part again, a window closes, or one open read finishes.
 */

type FakeRead = {
  owner: number;
  part: RecentProjectDiscoveryPart;
  request: number;
  closed: boolean;
  finish(): void;
};

type FakeClient = RecentCodexDirectoryClient & FakeRead;

function fakeClient(owner: number, request: number): FakeClient {
  let settle: { resolve: (value: RecentCodexDirectories) => void; reject: (error: Error) => void } | undefined;
  const client: FakeClient = {
    owner,
    part: "agents",
    request,
    closed: false,
    listRecentThreadDirectories: async () => await new Promise<RecentCodexDirectories>((resolve, reject) => {
      settle = { resolve, reject };
    }),
    close: async () => {
      client.closed = true;
      // Closing the transport fails the pending request, as the real client does.
      settle?.reject(new Error("app-server closed"));
    },
    finish: () => settle?.resolve({ complete: true, directories: [{ cwd: `/home/dev/w${owner}-r${request}` }] }),
  };
  return client;
}

/** A Claude Code history read that answers on `finish`, or stops on abort as the SDK worker does. */
function fakeClaudeRead(owner: number, request: number, reads: FakeRead[]) {
  return async (signal: AbortSignal): Promise<RecentClaudeCodeDirectories> => {
    const answer = Promise.withResolvers<RecentClaudeCodeDirectories>();
    const read: FakeRead = {
      owner,
      part: "claude-history",
      request,
      closed: false,
      finish: () => {
        read.closed = true;
        answer.resolve({ complete: true, directories: [{ cwd: `/home/dev/claude-w${owner}-r${request}`, updatedAt: 1 }] });
      },
    };
    reads.push(read);
    signal.addEventListener("abort", () => {
      read.closed = true;
      answer.reject(signal.reason);
    }, { once: true });
    return await answer.promise;
  };
}

function search(
  runs: RecentProjectDiscoveryRuns,
  reads: FakeRead[],
  owner: number,
  request: number,
  part: RecentProjectDiscoveryPart = "agents",
): Promise<DiscoverRecentProjectsResponse> {
  return runs.run(owner, part, async (signal) => await discoverRecentProjects({
    part,
    includeCodex: true,
    platform: "linux",
    signal,
    readCodexDirectories: async () => await readRecentCodexDirectories(() => {
      const client = fakeClient(owner, request);
      reads.push(client);
      return client;
    }, { signal }),
    readClaudeCodeDirectories: fakeClaudeRead(owner, request, reads),
    labelFor: (agent) => agent,
    resolveProjectRoot: async (folder) => folder,
  }));
}

const arbPart = fc.constantFrom<RecentProjectDiscoveryPart>("agents", "claude-history");

type Command =
  | { kind: "ask"; owner: number; part: RecentProjectDiscoveryPart }
  | { kind: "close"; owner: number }
  | { kind: "finish"; pick: number };

const arbCommands = fc.array(
  fc.oneof(
    fc.record({ kind: fc.constant("ask" as const), owner: fc.integer({ min: 0, max: 2 }), part: arbPart }),
    fc.record({ kind: fc.constant("close" as const), owner: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ kind: fc.constant("finish" as const), pick: fc.nat() }),
  ),
  { minLength: 1, maxLength: 30, size: "max" },
);

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("superseded recent project searches", () => {
  it("keeps at most one read open per window and part, the newest request's", async () => {
    await fc.assert(fc.asyncProperty(arbCommands, async (commands: Command[]) => {
      const runs = new RecentProjectDiscoveryRuns();
      const reads: FakeRead[] = [];
      const newest = new Map<string, number>();
      const slot = (owner: number, part: RecentProjectDiscoveryPart): string => `${owner}:${part}`;
      const pending: Array<{ part: RecentProjectDiscoveryPart; request: number; answer: Promise<DiscoverRecentProjectsResponse> }> = [];
      const finished = new Set<FakeRead>();

      for (const [index, command] of commands.entries()) {
        if (command.kind === "ask") {
          newest.set(slot(command.owner, command.part), index);
          pending.push({
            part: command.part,
            request: index,
            answer: search(runs, reads, command.owner, index, command.part),
          });
        } else if (command.kind === "close") {
          newest.delete(slot(command.owner, "agents"));
          newest.delete(slot(command.owner, "claude-history"));
          runs.cancel(command.owner);
        } else {
          const open = reads.filter((read) => !read.closed && !finished.has(read));
          if (open.length === 0) continue;
          const read = open[command.pick % open.length]!;
          finished.add(read);
          read.finish();
        }
        await settle();
        for (const read of reads) {
          const wanted = read.request === newest.get(slot(read.owner, read.part));
          // Replaced or closed: stopped. Still wanted and unfinished: still reading.
          if (!wanted) expect(read).toMatchObject({ closed: true });
          else if (!finished.has(read)) expect(read).toMatchObject({ closed: false });
        }
      }

      for (const read of reads) read.finish();
      const responses = await Promise.all(pending.map(async (entry) => ({ ...entry, response: await entry.answer })));
      expect(reads.every((read) => read.closed)).toBe(true);
      // A read that finished before a newer request arrived did not fail,
      // and each part answers only for its own agent.
      for (const { part, request, response } of responses) {
        const read = reads.find((candidate) => candidate.request === request);
        const agent = part === "agents" ? "codex" : "claude";
        const report = response.sources.find((source) => source.agent === agent);
        if (read && finished.has(read)) expect(report?.status).not.toBe("failed");
        if (part === "claude-history") {
          expect(response.sources.some((source) => source.agent === "codex")).toBe(false);
        }
      }
    }));
  });

  it("lets a window's Claude Code history read run while its agents part is asked again", async () => {
    const runs = new RecentProjectDiscoveryRuns();
    const reads: FakeRead[] = [];
    const history = search(runs, reads, 1, 1, "claude-history");
    const firstAgents = search(runs, reads, 1, 2, "agents");
    const secondAgents = search(runs, reads, 1, 3, "agents");
    await settle();
    const byRequest = (request: number): FakeRead => reads.find((read) => read.request === request)!;
    expect([1, 2, 3].map((request) => {
      const { part, closed } = byRequest(request);
      return { part, request, closed };
    })).toEqual([
      { part: "claude-history", request: 1, closed: false },
      { part: "agents", request: 2, closed: true },
      { part: "agents", request: 3, closed: false },
    ]);
    byRequest(3).finish();
    await expect(secondAgents).resolves.toMatchObject({ observations: [{ path: "/home/dev/w1-r3", agent: "codex" }] });
    await firstAgents;
    expect(byRequest(1).closed).toBe(false);
    byRequest(1).finish();
    await expect(history).resolves.toMatchObject({
      sources: [{ agent: "claude", status: "complete" }],
      observations: [{ path: "/home/dev/claude-w1-r1", agent: "claude" }],
    });
  });

  it("stops both parts when the window closes", async () => {
    const runs = new RecentProjectDiscoveryRuns();
    const reads: FakeRead[] = [];
    const answers = Promise.all([
      search(runs, reads, 1, 1, "agents"),
      search(runs, reads, 1, 2, "claude-history"),
    ]);
    await settle();
    runs.cancel(1);
    await settle();
    expect(reads.every((read) => read.closed)).toBe(true);
    const [agents, history] = await answers;
    expect(agents.sources).toContainEqual(expect.objectContaining({ agent: "codex", status: "failed" }));
    expect(history.sources).toContainEqual(expect.objectContaining({ agent: "claude", status: "failed" }));
  });

  it("closes the first App Server when React runs the effect twice", async () => {
    const runs = new RecentProjectDiscoveryRuns();
    const clients: FakeRead[] = [];
    const first = search(runs, clients, 1, 1);
    const second = search(runs, clients, 1, 2);
    await settle();
    expect(clients.map((client) => client.closed)).toEqual([true, false]);

    clients[1]!.finish();
    const [replaced, kept] = await Promise.all([first, second]);
    expect(replaced.sources).toContainEqual(expect.objectContaining({ agent: "codex", status: "failed" }));
    expect(replaced.observations).toEqual([]);
    expect(kept.observations).toEqual([{ path: "/home/dev/w1-r2", agent: "codex" }]);
    expect(clients[1]!.closed).toBe(true);
  });
});
