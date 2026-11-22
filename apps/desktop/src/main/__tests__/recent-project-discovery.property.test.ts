import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  DiscoverRecentProjectsResponse,
  RecentProjectAgent,
  RecentProjectObservation,
} from "@pwragent/shared/contracts/settings";
import { discoverRecentProjects } from "../onboarding/recent-project-discovery";

/*
 * Rule: the main process sends Get started one spelling per folder. Two
 * agents, or two threads of one agent, that name the same folder differently
 * (slashes, a trailing separator, or letter case where the platform's paths
 * ignore it) give one observation per agent, all with the same path, so the
 * renderer's exact-path merge shows one row. On a case-sensitive volume,
 * `App` and `app` are two folders.
 *
 * The oracle folds each reported path the way the platform names files:
 * forward slashes, no trailing separator, and lower case on Windows and the
 * case-insensitive macOS volume.
 */

const AGENTS: readonly RecentProjectAgent[] = ["codex", "claude", "acp:gemini"];

type Platform = "win32" | "linux" | "darwin";
type Reported = { cwd: string; agent: RecentProjectAgent; lastActiveAt?: number };

const MAC_INSENSITIVE_ROOT = "/Volumes/Insensitive/Code";
const MAC_SENSITIVE_ROOT = "/Volumes/Sensitive/Code";

function oracleIdentity(path: string, platform: Platform): string {
  const canonical = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const folded = canonical.toLowerCase();
  return platform === "win32" || (platform === "darwin" && folded.startsWith(`${MAC_INSENSITIVE_ROOT.toLowerCase()}/`))
    ? folded
    : canonical;
}

/** One folder as an agent might report it: separators, trailing slash, case. */
function spell(base: string, separators: number, caseMask: readonly boolean[]): string {
  let spelled = [...base]
    .map((char, index) => (caseMask[index % caseMask.length] ? char.toUpperCase() : char.toLowerCase()))
    .join("");
  if (separators === 1 || separators === 3) spelled = spelled.replace(/\//g, "\\");
  if (separators === 2) spelled = `${spelled}/`;
  if (separators === 3) spelled = `${spelled}\\`;
  return spelled;
}

const arbInput = fc.record({
  platform: fc.constantFrom<Platform>("win32", "linux", "darwin"),
  names: fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/), { minLength: 1, maxLength: 12 }),
}).chain(({ platform, names }) => {
  const root = platform === "win32" ? "c:/code" : "/home/dev";
  const folders = names.map((name) => `${root}/${name}`);
  const arbReported: fc.Arbitrary<Reported> = fc.record({
    index: fc.integer({ min: 0, max: folders.length - 1 }),
    caseSensitive: fc.boolean(),
    separators: fc.integer({ min: 0, max: 3 }),
    caseMask: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
    agent: fc.constantFrom(...AGENTS),
    // A narrow range so ties and undated reports are common.
    lastActiveAt: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
  }).map(({ index, caseSensitive, separators, caseMask, agent, lastActiveAt }) => ({
    cwd: platform !== "darwin" ? spell(folders[index]!, separators, caseMask)
      : caseSensitive ? `${MAC_SENSITIVE_ROOT}/${spell(names[index]!, 0, caseMask)}`
      : spell(`${MAC_INSENSITIVE_ROOT}/${names[index]!}`, 0, caseMask),
    agent,
    ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
  }));
  return fc.record({
    platform: fc.constant(platform),
    reported: fc.array(arbReported, { minLength: 1, maxLength: 40, size: "max" }),
  });
});

function thread(report: Reported, index: number): AppServerThreadSummary {
  return {
    id: `thread-${index}`,
    title: "Thread",
    titleSource: "explicit",
    linkedDirectories: [],
    source: report.agent,
    projectKey: report.cwd,
    ...(report.lastActiveAt === undefined ? {} : { updatedAt: report.lastActiveAt }),
  };
}

/**
 * The modeled folders are outside Git. On macOS the disk returns the stored
 * spelling, with differently cased entries sharing one physical folder only
 * on the case-insensitive volume.
 */
async function discover(platform: Platform, reported: readonly Reported[]): Promise<DiscoverRecentProjectsResponse> {
  return await discoverRecentProjects({
    includeCodex: true,
    platform,
    realpath: async (folder) => {
      if (platform !== "darwin" || folder.startsWith(`${MAC_SENSITIVE_ROOT}/`)) return folder;
      return `${MAC_INSENSITIVE_ROOT}/${folder.slice(MAC_INSENSITIVE_ROOT.length + 1).toLowerCase()}`;
    },
    readCodexDirectories: async () => ({
      complete: true,
      directories: reported.filter((report) => report.agent === "codex")
        .map((report) => (report.lastActiveAt === undefined
          ? { cwd: report.cwd }
          : { cwd: report.cwd, updatedAt: report.lastActiveAt })),
    }),
    listPwrAgentThreads: async () => reported.map(thread).filter((summary) => summary.source !== "codex"),
    labelFor: (agent) => agent,
    resolveProjectRoot: async (folder) => folder.replace(/\\/g, "/").replace(/\/+$/, ""),
  });
}

function sorted(observations: readonly RecentProjectObservation[]): RecentProjectObservation[] {
  return [...observations].sort((left, right) =>
    left.agent.localeCompare(right.agent) || left.path.localeCompare(right.path));
}

describe("recent project discovery path identity", () => {
  it("sends one spelling per folder, one observation per agent, at its newest time", async () => {
    await fc.assert(fc.asyncProperty(arbInput, async ({ platform, reported }) => {
      const { observations } = await discover(platform, reported);

      const expected = new Map<string, { agent: RecentProjectAgent; identity: string; lastActiveAt?: number }>();
      for (const report of reported) {
        const identity = oracleIdentity(report.cwd, platform);
        const id = JSON.stringify([report.agent, identity]);
        const entry = expected.get(id) ?? { agent: report.agent, identity };
        if (report.lastActiveAt !== undefined) {
          entry.lastActiveAt = Math.max(entry.lastActiveAt ?? Number.NEGATIVE_INFINITY, report.lastActiveAt);
        }
        expected.set(id, entry);
      }

      const spellings = new Map<string, Set<string>>();
      for (const observation of observations) {
        const identity = oracleIdentity(observation.path, platform);
        spellings.set(identity, (spellings.get(identity) ?? new Set()).add(observation.path));
      }
      for (const [identity, paths] of spellings) {
        expect({ identity, paths: [...paths] }).toEqual({ identity, paths: [expect.any(String)] });
      }

      expect(observations.map((observation) => ({
        agent: observation.agent,
        identity: oracleIdentity(observation.path, platform),
        lastActiveAt: observation.lastActiveAt,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
        .toEqual([...expected.values()].map((entry) => ({
          agent: entry.agent,
          identity: entry.identity,
          lastActiveAt: entry.lastActiveAt,
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
    }));
  });

  it("sends the same observations whatever order the agents reported in", async () => {
    await fc.assert(fc.asyncProperty(
      arbInput.chain(({ platform, reported }) => fc.tuple(
        fc.constant(platform),
        fc.constant(reported),
        fc.shuffledSubarray(reported, { minLength: reported.length, maxLength: reported.length }),
      )),
      async ([platform, reported, shuffled]) => {
        const [first, second] = await Promise.all([discover(platform, reported), discover(platform, shuffled)]);
        expect(sorted(second.observations)).toEqual(sorted(first.observations));
      },
    ));
  });

  it("merges a Windows folder that two agents spell in different case", async () => {
    const { observations } = await discover("win32", [
      { cwd: "C:/code/app", agent: "codex", lastActiveAt: 5 },
      { cwd: "c:\\Code\\App\\", agent: "claude", lastActiveAt: 7 },
    ]);
    expect(new Set(observations.map((observation) => observation.path)).size).toBe(1);
    expect(sorted(observations).map((observation) => [observation.agent, observation.lastActiveAt]))
      .toEqual([["claude", 7], ["codex", 5]]);
  });

  it("uses the stored spelling on a case-insensitive Mac volume and keeps distinct folders on another volume", async () => {
    const { observations } = await discover("darwin", [
      { cwd: "/volumes/insensitive/code/A", agent: "codex", lastActiveAt: 5 },
      { cwd: `${MAC_INSENSITIVE_ROOT}/a`, agent: "claude", lastActiveAt: 7 },
      { cwd: `${MAC_SENSITIVE_ROOT}/A`, agent: "codex", lastActiveAt: 9 },
      { cwd: `${MAC_SENSITIVE_ROOT}/a`, agent: "claude", lastActiveAt: 11 },
    ]);
    expect(new Set(observations.map((observation) => observation.path))).toEqual(new Set([
      `${MAC_INSENSITIVE_ROOT}/a`,
      `${MAC_SENSITIVE_ROOT}/A`,
      `${MAC_SENSITIVE_ROOT}/a`,
    ]));
  });
});
