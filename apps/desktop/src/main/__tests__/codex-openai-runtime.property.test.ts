import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CODEX_MINIMUM_RECOMMENDED_VERSION,
  isCodexVersionBelowMinimum,
} from "@pwragent/shared/codex-version";
import type {
  DesktopCodexCandidateSource,
  DesktopCodexDiscoveryCandidate,
  DesktopCodexDiscoverySnapshot,
} from "@pwragent/shared/contracts/settings";
import {
  applyOpenAiCodexFallback,
  compareOpenAiCodexVersions,
  ensureOpenAiCodexRuntime,
  isOpenAiCodexReleaseEligible,
  planOpenAiCodexUpdate,
  readInstalledOpenAiCodexRuntime,
  resetOpenAiCodexRuntimeChecks,
  selectPrunableOpenAiCodexVersions,
} from "../codex-openai-runtime";
import {
  appleSilicon,
  makeOpenAiCodexPackage,
  openAiReleaseFetch,
  probeFixtureVersion,
  recordingProgress,
} from "./codex-openai-runtime-fixture";

const STOCK = {
  command: "/home/u/.pwragent/agents/codex/openai/versions/0.172.0/bin/codex",
  version: "0.172.0",
};

const versionArb = fc.oneof(
  fc.constantFrom("0.150.0", "0.158.9", CODEX_MINIMUM_RECOMMENDED_VERSION, "0.159.1", "0.172.0", "1.0.0"),
  fc.tuple(fc.nat(2), fc.nat(200), fc.nat(9)).map(([a, b, c]) => `${a}.${b}.${c}`),
);

const sourceArb = fc.constantFrom<DesktopCodexCandidateSource>("env", "config", "path", "application");

/**
 * Snapshots shaped the way discovery produces them: distinct commands, at most
 * one selected, and a selected candidate that started with a version.
 */
const snapshotArb: fc.Arbitrary<DesktopCodexDiscoverySnapshot> = fc
  .tuple(
    fc.uniqueArray(
      fc.record({
        command: fc.constantFrom("/usr/local/bin/codex", "/opt/homebrew/bin/codex", "codex", "/a/codex", STOCK.command),
        source: sourceArb,
        version: fc.option(versionArb, { nil: undefined }),
        failureReason: fc.option(fc.constant("codex_too_old"), { nil: undefined }),
      }),
      { selector: (candidate) => candidate.command, maxLength: 5 },
    ),
    fc.nat(),
  )
  .map(([rows, pick]) => {
    const eligible = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.version !== undefined && !row.failureReason);
    const selectedIndex = eligible.length > 0 && pick % 3 !== 0
      ? eligible[pick % eligible.length]!.index
      : -1;
    const candidates: DesktopCodexDiscoveryCandidate[] = rows.map((row, index) => ({
      command: row.command,
      source: row.source,
      executable: !row.failureReason,
      selected: index === selectedIndex,
      ...(row.version ? { version: row.version } : {}),
      ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    }));
    const selected = candidates[selectedIndex];
    return selected
      ? { candidates, selectedCommand: selected.command, selectedSource: selected.source }
      : { candidates };
  });

const runtimeArb = fc.option(
  fc.constantFrom(STOCK, { command: "/r/versions/0.160.0/bin/codex", version: "0.160.0" }),
  { nil: undefined },
);

function selectedOf(snapshot: DesktopCodexDiscoverySnapshot) {
  return snapshot.candidates.filter((candidate) => candidate.selected);
}

/** The rule from the design: who wins over the PwrAgent-installed OpenAI Codex. */
function userCodexWins(
  snapshot: DesktopCodexDiscoverySnapshot,
  runtime: { command: string },
): boolean {
  const [selected] = selectedOf(snapshot);
  return selected !== undefined && (
    selected.command === runtime.command
    || selected.source === "env"
    || selected.source === "config"
    || !isCodexVersionBelowMinimum(selected.version)
  );
}

describe("applyOpenAiCodexFallback", () => {
  it("selects the install exactly when no explicit or current user Codex was selected", () => {
    fc.assert(fc.property(snapshotArb, runtimeArb, (snapshot, runtime) => {
      const result = applyOpenAiCodexFallback(snapshot, runtime);
      if (!runtime || userCodexWins(snapshot, runtime)) {
        expect(result).toEqual(snapshot);
        return;
      }
      expect(selectedOf(result)).toEqual([expect.objectContaining({
        command: runtime.command,
        version: runtime.version,
        source: "application",
      })]);
      expect(result.selectedCommand).toBe(runtime.command);
      expect(result.selectedSource).toBe("application");
    }));
  });

  it("keeps at most one selection, named by selectedCommand", () => {
    fc.assert(fc.property(snapshotArb, runtimeArb, (snapshot, runtime) => {
      const result = applyOpenAiCodexFallback(snapshot, runtime);
      const selected = selectedOf(result);
      expect(selected.length).toBeLessThanOrEqual(1);
      expect(result.selectedCommand).toBe(selected[0]?.command);
    }));
  });

  it("drops no other candidate, so Settings still lists what discovery found", () => {
    fc.assert(fc.property(snapshotArb, runtimeArb, (snapshot, runtime) => {
      const commands = new Set(applyOpenAiCodexFallback(snapshot, runtime).candidates.map((c) => c.command));
      for (const candidate of snapshot.candidates) expect(commands.has(candidate.command)).toBe(true);
    }));
  });

  it("is idempotent: the recorded snapshot and a later peek agree", () => {
    fc.assert(fc.property(snapshotArb, runtimeArb, (snapshot, runtime) => {
      const once = applyOpenAiCodexFallback(snapshot, runtime);
      expect(applyOpenAiCodexFallback(once, runtime)).toEqual(once);
    }));
  });

  // Committed counterexamples for the rules above.
  it("leaves a working PATH Codex selected", () => {
    const snapshot: DesktopCodexDiscoverySnapshot = {
      candidates: [{ command: "codex", source: "path", executable: true, selected: true, version: "0.165.0" }],
      selectedCommand: "codex",
      selectedSource: "path",
    };
    expect(applyOpenAiCodexFallback(snapshot, STOCK)).toBe(snapshot);
  });

  it("takes over from a PATH Codex too old for the newest models", () => {
    const snapshot: DesktopCodexDiscoverySnapshot = {
      candidates: [{ command: "codex", source: "path", executable: true, selected: true, version: "0.150.0" }],
      selectedCommand: "codex",
      selectedSource: "path",
    };
    expect(applyOpenAiCodexFallback(snapshot, STOCK).selectedCommand).toBe(STOCK.command);
  });

  it("never overrides an old Codex the operator configured", () => {
    const snapshot: DesktopCodexDiscoverySnapshot = {
      candidates: [{ command: "/a/codex", source: "config", executable: true, selected: true, version: "0.150.0" }],
      selectedCommand: "/a/codex",
      selectedSource: "config",
    };
    expect(applyOpenAiCodexFallback(snapshot, STOCK)).toBe(snapshot);
  });
});

describe("planOpenAiCodexUpdate", () => {
  const installedArb = fc.option(versionArb, { nil: undefined });

  it("installs only an eligible release newer than the installed one", () => {
    fc.assert(fc.property(installedArb, fc.option(versionArb, { nil: undefined }), (installed, latest) => {
      const plan = planOpenAiCodexUpdate({ installed, latest });
      const expected = isOpenAiCodexReleaseEligible(latest)
        && (installed === undefined || compareOpenAiCodexVersions(latest, installed) > 0);
      expect(plan).toBe(expected ? "install" : "keep");
    }));
  });

  it("never moves the installed version backwards or below the minimum", () => {
    fc.assert(fc.property(fc.array(versionArb, { minLength: 1, maxLength: 8 }), (feed) => {
      let installed: string | undefined;
      for (const latest of feed) {
        if (planOpenAiCodexUpdate({ installed, latest }) === "install") {
          expect(compareOpenAiCodexVersions(latest, installed)).toBeGreaterThan(0);
          expect(isCodexVersionBelowMinimum(latest)).toBe(false);
          installed = latest;
        }
      }
    }));
  });
});

describe("selectPrunableOpenAiCodexVersions", () => {
  const nameArb = fc.oneof(versionArb, fc.constantFrom(".install-abc", "notes", "0.172", "v0.172.0"));

  it("removes every other version and nothing current, in use, or foreign", () => {
    fc.assert(fc.property(
      fc.uniqueArray(nameArb, { maxLength: 8 }),
      versionArb,
      fc.func(fc.boolean()),
      (entries, current, used) => {
        const inUse = new Set(entries.filter((name) => used(name)));
        const pruned = new Set(selectPrunableOpenAiCodexVersions({ entries, current, inUse }));
        for (const name of entries) {
          const isVersion = /^\d+\.\d+\.\d+$/u.test(name);
          expect(pruned.has(name)).toBe(isVersion && name !== current && !inUse.has(name));
        }
      },
    ));
  });
});

/**
 * Model: the install follows the newest eligible release npm has named, never
 * moving backwards, and every version this process activated stays on disk for
 * the app server that may still run it. Real files, real tar, fake network.
 */
describe.skipIf(process.platform === "win32")("update sequence model", () => {
  // Ascending, so the model needs no version arithmetic of its own. Only the
  // first is below the recommended minimum.
  const VERSIONS = ["0.150.0", "0.160.0", "0.170.0", "0.172.0"] as const;
  const FIRST_ELIGIBLE = 1;
  let scratch: string;
  const archives = new Map<string, Buffer>();

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), "openai-codex-model-"));
    for (const version of VERSIONS) archives.set(version, await makeOpenAiCodexPackage(scratch, version));
    return async () => await rm(scratch, { recursive: true, force: true });
  });

  afterEach(() => {
    resetOpenAiCodexRuntimeChecks();
  });

  it("matches the model after every forced check", async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom(...VERSIONS), { minLength: 1, maxLength: 4 }),
      async (feed) => {
        const rootDir = path.join(scratch, `model-${run++}`);
        let latest = feed[0]!;
        const base = {
          ...appleSilicon, rootDir, checkMode: "force" as const,
          fetch: openAiReleaseFetch({ latest: () => latest, archives }),
          probeVersion: probeFixtureVersion, progress: recordingProgress(),
        };
        let model: (typeof VERSIONS)[number] | undefined;
        const activated = new Set<string>();
        for (latest of feed) {
          const rank = VERSIONS.indexOf(latest);
          if (rank >= FIRST_ELIGIBLE && (model === undefined || rank > VERSIONS.indexOf(model))) {
            model = latest;
          }
          const result = await ensureOpenAiCodexRuntime(base).catch(() => undefined);
          expect(result?.version).toBe(model);
          expect((await readInstalledOpenAiCodexRuntime(base))?.version).toBe(model);
          if (model) activated.add(model);
          const onDisk = await readdir(path.join(rootDir, "versions")).catch(() => []);
          expect(new Set(onDisk)).toEqual(activated);
        }
      },
    ), { numRuns: 5 });
  });
});
