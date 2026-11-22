import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DiscoverRecentProjectsResponse } from "@pwragent/shared/contracts/settings";
import {
  discoverRecentProjects,
  readRecentCodexDirectories,
  RecentProjectDiscoveryRuns,
  type RecentCodexDirectories,
  type RecentCodexDirectoryClient,
} from "../onboarding/recent-project-discovery";

/*
 * Rule: a window has at most one Codex App Server open for Get started's
 * project search, and it belongs to that window's newest request. A request
 * the window replaced closes its App Server at once rather than paging
 * `thread/list` to the end, and a window that closes has none open. Other
 * windows' searches are untouched.
 *
 * Model: per window, the newest request still wanted. Commands: a window
 * asks again, a window closes, or one open App Server finishes its read.
 */

type FakeClient = RecentCodexDirectoryClient & {
  owner: number;
  request: number;
  closed: boolean;
  finish(): void;
};

function fakeClient(owner: number, request: number): FakeClient {
  let settle: { resolve: (value: RecentCodexDirectories) => void; reject: (error: Error) => void } | undefined;
  const client: FakeClient = {
    owner,
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

function search(
  runs: RecentProjectDiscoveryRuns,
  clients: FakeClient[],
  owner: number,
  request: number,
): Promise<DiscoverRecentProjectsResponse> {
  return runs.run(owner, async (signal) => await discoverRecentProjects({
    includeCodex: true,
    ignorePathCase: false,
    signal,
    readCodexDirectories: async () => await readRecentCodexDirectories(() => {
      const client = fakeClient(owner, request);
      clients.push(client);
      return client;
    }, { signal }),
    labelFor: (agent) => agent,
    resolveProjectRoot: async (folder) => folder,
  }));
}

type Command =
  | { kind: "ask"; owner: number }
  | { kind: "close"; owner: number }
  | { kind: "finish"; pick: number };

const arbCommands = fc.array(
  fc.oneof(
    fc.record({ kind: fc.constant("ask" as const), owner: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ kind: fc.constant("close" as const), owner: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ kind: fc.constant("finish" as const), pick: fc.nat() }),
  ),
  { minLength: 1, maxLength: 30, size: "max" },
);

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("superseded recent project searches", () => {
  it("keeps at most one App Server open per window, the newest request's", async () => {
    await fc.assert(fc.asyncProperty(arbCommands, async (commands: Command[]) => {
      const runs = new RecentProjectDiscoveryRuns();
      const clients: FakeClient[] = [];
      const newest = new Map<number, number>();
      const pending: Array<Promise<DiscoverRecentProjectsResponse>> = [];
      const finished = new Set<FakeClient>();

      for (const [index, command] of commands.entries()) {
        if (command.kind === "ask") {
          newest.set(command.owner, index);
          pending.push(search(runs, clients, command.owner, index));
        } else if (command.kind === "close") {
          newest.delete(command.owner);
          runs.cancel(command.owner);
        } else {
          const open = clients.filter((client) => !client.closed && !finished.has(client));
          if (open.length === 0) continue;
          const client = open[command.pick % open.length]!;
          finished.add(client);
          client.finish();
        }
        await settle();
        for (const client of clients) {
          if (client.request !== newest.get(client.owner)) expect(client).toMatchObject({ closed: true });
        }
      }

      for (const client of clients) client.finish();
      const responses = await Promise.all(pending);
      expect(clients.every((client) => client.closed)).toBe(true);
      // A read that finished before a newer request arrived did not fail.
      for (const [index, response] of responses.entries()) {
        const client = clients[index]!;
        const codex = response.sources.find((source) => source.agent === "codex");
        if (finished.has(client)) expect(codex?.status).not.toBe("failed");
      }
    }));
  });

  it("closes the first App Server when React runs the effect twice", async () => {
    const runs = new RecentProjectDiscoveryRuns();
    const clients: FakeClient[] = [];
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
