import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  DiscoverRecentProjectsResponse,
  RecentProjectAgent,
  RecentProjectDiscoveryPart,
  RecentProjectObservation,
} from "@pwragent/shared/contracts/settings";
import { mergeRecentProjectDiscoveries } from "@pwragent/shared/recent-project-discovery";
import { registerDirectoryFromDisk, resolveDirectoryRegistrationRoot, type DirectoryRegistrationDeps } from "../app-server/directory-registration-service";
import { readRecentClaudeCodeDirectories } from "../claude/claude-recent-projects";
import { discoverRecentProjects, type RecentProjectDiscoveryDeps } from "../onboarding/recent-project-discovery";

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
async function discover(
  platform: Platform,
  reported: readonly Reported[],
  overrides?: Partial<RecentProjectDiscoveryDeps>,
): Promise<DiscoverRecentProjectsResponse> {
  return await discoverRecentProjects({
    includeCodex: true,
    platform,
    macDirectorySpelling: async (folder) => {
      if (folder.startsWith(`${MAC_SENSITIVE_ROOT}/`)) return folder;
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
    ...overrides,
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

async function withMacFixture(run: (folder: string) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(path.join(await realpath(os.tmpdir()), "pwragent-project-spelling-"));
  try {
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Ask the disk whether the alternate spelling resolves before creating it. */
async function createFolderSpellings(stored: string, alternate: string): Promise<boolean> {
  await mkdir(stored);
  try {
    await lstat(alternate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(alternate);
    return false;
  }
}

const noGit = async () => "";

function registrationRecorder() {
  return vi.fn<DirectoryRegistrationDeps["ensureDirectoryLaunchpad"]>(async (request) => ({
    launchpad: { ...request, backend: "codex", executionMode: "default", prompt: "", workMode: "local", createdAt: 1, updatedAt: 1 },
    defaults: { backend: "codex", executionMode: "default" },
  }));
}

async function discoverMacFolders(folders: string[]): Promise<string[]> {
  const { observations } = await discover("darwin", folders.map((cwd) => ({ cwd, agent: "codex" })), {
    macDirectorySpelling: undefined,
    resolveProjectRoot: async (cwd) => {
      const root = await resolveDirectoryRegistrationRoot(cwd, { runGit: noGit });
      return root.ok ? root.directoryPath : undefined;
    },
  });
  return observations.map(({ path }) => path).sort();
}

describe.skipIf(process.platform !== "darwin")("recent projects against the macOS filesystem", () => {
  it("uses the names of linked path components and their children, including APFS Unicode case matches", async () => {
    await withMacFixture(async (folder) => {
      const target = path.join(folder, "target");
      const alias = path.join(folder, "Alias");
      const alternateAlias = path.join(folder, "alias");
      await mkdir(target);
      await symlink(target, alias);
      const aliasIgnoresCase = await lstat(alternateAlias).then(() => true, () => false);
      const aliases = aliasIgnoresCase ? [alias, alternateAlias] : [alias];
      expect(await discoverMacFolders([alias, target])).toEqual([alias, target].sort());
      const [discoveredAlias] = await discoverMacFolders([aliases[aliases.length - 1]!]);
      await expect(registerDirectoryFromDisk({ path: discoveredAlias! }, {
        ensureDirectoryLaunchpad: registrationRecorder(),
        runGit: noGit,
        listRegisteredProjectPaths: async () => [target, `${alias}/`],
      })).resolves.toMatchObject({ ok: true, directoryKey: `directory:${alias}/` });

      for (const [stored, alternate] of [["Project", "project"], ["ΟΣ", "οσ"]] as const) {
        const ignoresCase = await createFolderSpellings(path.join(target, stored), path.join(target, alternate));
        const reported = aliases.flatMap((name) => [path.join(name, stored), path.join(name, alternate)]);
        const expected = ignoresCase ? [path.join(alias, stored)] : [path.join(alias, stored), path.join(alias, alternate)];
        expect(await discoverMacFolders(reported)).toEqual(expected.sort());
        expect(await discoverMacFolders([path.join(target, alternate)])).toEqual([
          path.join(target, ignoresCase ? stored : alternate),
        ]);
      }
    });
  });

  it("registers a discovered project under its existing key exactly when the disk treats the spellings as one folder", async () => {
    await fc.assert(fc.asyncProperty(fc.stringMatching(/^[a-z]{1,5}$/), async (name) => {
      await withMacFixture(async (folder) => {
        const stored = path.join(folder, name.toUpperCase());
        const legacy = path.join(folder, name);
        const ignoresCase = await createFolderSpellings(stored, legacy);
        const ensureDirectoryLaunchpad = registrationRecorder();
        const old = await registerDirectoryFromDisk({ path: legacy }, { ensureDirectoryLaunchpad, runGit: noGit });
        expect(old).toMatchObject({ ok: true, directoryKey: `directory:${legacy}` });

        const [discovered] = await discoverMacFolders([stored]);
        expect(discovered).toBe(stored);
        const registrationDeps = {
          ensureDirectoryLaunchpad,
          runGit: noGit,
          listRegisteredProjectPaths: async () => [legacy],
        };
        const registration = await registerDirectoryFromDisk({ path: discovered! }, registrationDeps);
        const expected = `directory:${ignoresCase ? legacy : stored}`;
        expect(registration).toMatchObject({ ok: true, directoryKey: expected });
        expect(ensureDirectoryLaunchpad).toHaveBeenLastCalledWith(expect.objectContaining({ directoryKey: expected }));
      });
    }), { numRuns: 12 });
  });
});

describe("Claude Code recent projects", () => {
  it("keeps only directory metadata, even when SDK errors quote private text", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        sessionId: fc.uuid(),
        summary: fc.uuid().map((id) => `summary:${id}`),
        firstPrompt: fc.uuid().map((id) => `prompt:${id}`),
        customTitle: fc.uuid().map((id) => `title:${id}`),
        tag: fc.uuid().map((id) => `tag:${id}`),
        lastModified: fc.nat(),
      }), { minLength: 1 }),
      fc.boolean(),
      async (sessions, fails) => {
        const privateText = sessions.flatMap(({ summary, firstPrompt, customTitle, tag }) =>
          [summary, firstPrompt, customTitle, tag]);
        const cwd = "/home/dev/project";
        const read = () => readRecentClaudeCodeDirectories(async () => {
          if (fails) throw new Error(privateText.join(" "));
          return sessions.map((entry) => ({ ...entry, cwd }));
        });
        const result = await discoverRecentProjects({
          includeCodex: false,
          platform: "linux",
          readClaudeCodeDirectories: read,
          labelFor: (agent) => agent,
          resolveProjectRoot: async (folder) => folder,
        });
        expect(result.sources.find(({ agent }) => agent === "claude")?.status).toBe(fails ? "failed" : "complete");
        const serializedResult = JSON.stringify(result);
        const serializedAdapter = fails ? "" : JSON.stringify(await read());
        for (const value of privateText) {
          expect(serializedResult).not.toContain(value);
          expect(serializedAdapter).not.toContain(value);
        }
      },
    ));
  });

  it("keeps the newest activity for each resolved folder and the worst attempted status", async () => {
    const activity = fc.array(fc.record({
      project: fc.integer({ min: 0, max: 4 }),
      checkout: fc.integer({ min: 0, max: 2 }),
      updatedAt: fc.nat(),
    }), { minLength: 1 });
    await fc.assert(fc.asyncProperty(
      activity, activity,
      fc.constantFrom("skipped", "complete", "partial", "failed"),
      fc.constantFrom("skipped", "complete", "failed"),
      async (history, saved, historyStatus, savedStatus) => {
        const root = (project: number) => `/dev/project-${project}`;
        const folder = (entry: { project: number; checkout: number }) => `${root(entry.project)}/checkout-${entry.checkout}`;
        const historyRead = historyStatus === "complete" || historyStatus === "partial";
        const result = await discoverRecentProjects({
          includeCodex: false,
          platform: "linux",
          readClaudeCodeDirectories: async () => {
            if (historyStatus === "failed") throw new Error("history failed");
            if (!historyRead) return undefined;
            return {
              complete: historyStatus === "complete",
              directories: history.map((entry) => ({ cwd: folder(entry), updatedAt: entry.updatedAt })),
            };
          },
          listPwrAgentThreads: async () => {
            if (savedStatus === "failed") throw new Error("PwrAgent read failed");
            return savedStatus === "skipped" ? [] : saved.map((entry, index) => thread({
              agent: "claude", cwd: folder(entry), lastActiveAt: entry.updatedAt,
            }, index));
          },
          labelFor: (agent) => agent,
          resolveProjectRoot: async (cwd) => cwd.slice(0, cwd.lastIndexOf("/")),
        });
        const status = (["failed", "partial", "complete", "skipped"] as const)
          .find((candidate) => candidate === historyStatus || candidate === savedStatus);
        expect(result.sources.filter(({ agent }) => agent === "claude")).toEqual([
          expect.objectContaining({ agent: "claude", status }),
        ]);
        const available = [...(historyRead ? history : []), ...(savedStatus === "complete" ? saved : [])];
        const expected = [...new Set(available.map(({ project }) => project))].map((project) => ({
          agent: "claude" as const,
          path: root(project),
          lastActiveAt: Math.max(...available.filter((entry) => entry.project === project).map((entry) => entry.updatedAt)),
        }));
        expect(sorted(result.observations)).toEqual(sorted(expected));
      },
    ));
  });
});

/*
 * Rule: Get started asks for the agents part and the Claude Code history
 * part separately, so a slow history read never holds back the rest. The
 * parts together must say what one request running every read says: the
 * same report per agent and the same newest time per project and agent.
 *
 * Oracle: `discoverRecentProjects` without a part, against the same reads.
 * Below the folder and project budgets, so neither answer drops a folder.
 */
describe("recent project discovery parts", () => {
  type ReadOutcome = "complete" | "partial" | "failed" | "unavailable";
  const arbActivity = fc.array(fc.record({
    project: fc.integer({ min: 0, max: 5 }),
    updatedAt: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
  }), { maxLength: 8 });
  const arbAgentActivity = fc.array(fc.record({
    project: fc.integer({ min: 0, max: 5 }),
    agent: fc.constantFrom<RecentProjectAgent>("claude", "acp:gemini"),
    updatedAt: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
  }), { maxLength: 8 });
  const arbOutcome = fc.constantFrom<ReadOutcome>("complete", "partial", "failed", "unavailable");

  function reads(input: {
    includeCodex: boolean;
    codex: ReadOutcome;
    codexActivity: Array<{ project: number; updatedAt?: number }>;
    history: ReadOutcome;
    historyActivity: Array<{ project: number; updatedAt?: number }>;
    threads: "listed" | "failed" | "bootstrap";
    threadActivity: Array<{ project: number; agent: RecentProjectAgent; updatedAt?: number }>;
  }, part?: RecentProjectDiscoveryPart): RecentProjectDiscoveryDeps {
    const folder = (project: number) => `/home/dev/project-${project}`;
    const dated = (updatedAt: number | undefined) => (updatedAt === undefined ? {} : { updatedAt });
    return {
      ...(part ? { part } : {}),
      includeCodex: input.includeCodex,
      platform: "linux",
      readCodexDirectories: input.codex === "unavailable" ? undefined : async () => {
        if (input.codex === "failed") throw new Error("Codex read failed");
        return {
          complete: input.codex === "complete",
          directories: input.codexActivity.map(({ project, updatedAt }) => ({ cwd: folder(project), ...dated(updatedAt) })),
        };
      },
      readClaudeCodeDirectories: async () => {
        if (input.history === "failed") throw new Error("Claude Code read failed");
        if (input.history === "unavailable") return undefined;
        return {
          complete: input.history === "complete",
          directories: input.historyActivity.map(({ project, updatedAt }) => ({ cwd: folder(project), updatedAt: updatedAt ?? 0 })),
        };
      },
      listPwrAgentThreads: input.threads === "bootstrap" ? undefined : async () => {
        if (input.threads === "failed") throw new Error("PwrAgent read failed");
        return input.threadActivity.map(({ project, agent, updatedAt }, index) => thread({
          cwd: folder(project), agent, ...(updatedAt === undefined ? {} : { lastActiveAt: updatedAt }),
        }, index));
      },
      labelFor: (agent) => agent,
      resolveProjectRoot: async (cwd) => cwd,
    };
  }

  /** The newest time per (project, agent): what the renderer's merge keeps. */
  function newestPerProject(observations: readonly RecentProjectObservation[]): Map<string, number | undefined> {
    const newest = new Map<string, number | undefined>();
    for (const { path, agent, lastActiveAt } of observations) {
      const key = `${agent} ${path}`;
      const existing = newest.get(key);
      newest.set(key, existing === undefined ? lastActiveAt : Math.max(existing, lastActiveAt ?? existing));
    }
    return newest;
  }

  it("says together what one request running every read says", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        includeCodex: fc.boolean(),
        codex: arbOutcome,
        codexActivity: arbActivity,
        history: arbOutcome,
        historyActivity: arbActivity,
        threads: fc.constantFrom("listed" as const, "failed" as const, "bootstrap" as const),
        threadActivity: arbAgentActivity,
      }),
      async (input) => {
        const whole = await discoverRecentProjects(reads(input));
        // The history answer first, as Get started passes it.
        const parts = mergeRecentProjectDiscoveries([
          await discoverRecentProjects(reads(input, "claude-history")),
          await discoverRecentProjects(reads(input, "agents")),
        ]);
        const byAgent = (answer: DiscoverRecentProjectsResponse) =>
          [...answer.sources].sort((left, right) => left.agent.localeCompare(right.agent));
        expect(byAgent(parts)).toEqual(byAgent(whole));
        expect(newestPerProject(parts.observations)).toEqual(newestPerProject(whole.observations));
      },
    ));
  });

  it("runs only its own reads", async () => {
    const asked: string[] = [];
    const deps = (part: RecentProjectDiscoveryPart): RecentProjectDiscoveryDeps => ({
      part,
      includeCodex: true,
      platform: "linux",
      readCodexDirectories: async () => {
        asked.push(`${part}:codex`);
        return { complete: true, directories: [] };
      },
      readClaudeCodeDirectories: async () => {
        asked.push(`${part}:claude-history`);
        return { complete: true, directories: [] };
      },
      listPwrAgentThreads: async () => {
        asked.push(`${part}:threads`);
        return [];
      },
      labelFor: (agent) => agent,
      resolveProjectRoot: async (cwd) => cwd,
    });
    const agents = await discoverRecentProjects(deps("agents"));
    const history = await discoverRecentProjects(deps("claude-history"));
    expect(asked).toEqual(["agents:codex", "agents:threads", "claude-history:claude-history"]);
    expect(agents.sources.map(({ agent, status }) => [agent, status])).toEqual([["codex", "complete"], ["claude", "skipped"]]);
    expect(history.sources.map(({ agent, status }) => [agent, status])).toEqual([["claude", "complete"]]);
  });
});
