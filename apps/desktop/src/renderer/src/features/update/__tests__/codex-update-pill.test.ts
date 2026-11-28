import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DesktopCodexInstaller } from "@pwragent/shared/contracts/settings";
import {
  CODEX_USER_UPDATE_ACTIVE_PHASES,
  deriveCodexUserUpdateOffer,
  type CodexUserUpdatePhase,
  type CodexUserUpdateRun,
  type CodexUserUpdateState,
} from "../../../../../shared/codex-user-update";
import {
  buildCodexUpdatePillView,
  codexUpdateOfferDismissKey,
} from "../codex-update-pill";

const INSTALLERS: DesktopCodexInstaller[] = [
  "homebrew", "npm", "pnpm", "bun", "standalone", "application", "unknown",
];
const PHASES: CodexUserUpdatePhase[] = [
  "updating", "verifying", "restarting", "succeeded", "unchanged", "failed",
];
const version = fc.tuple(fc.nat(1), fc.nat(200), fc.nat(5)).map((parts) => parts.join("."));

/** An offer the main process can produce: derived, never hand-built. */
const offer = fc.record({
  installed: version,
  latest: version,
  installer: fc.constantFrom(...INSTALLERS),
  command: fc.option(fc.constantFrom("brew upgrade codex", "npm install -g @openai/codex@latest"), { nil: undefined }),
  runnable: fc.boolean(),
}).map((input) => deriveCodexUserUpdateOffer({
  installedVersion: input.installed,
  latestVersion: input.latest,
  installer: input.installer,
  ...(input.command ? { upgradeCommand: input.command } : {}),
  runnable: input.runnable,
}));

const run: fc.Arbitrary<CodexUserUpdateRun> = fc.record({
  id: fc.integer({ min: 1, max: 5 }),
  phase: fc.constantFrom(...PHASES),
  installer: fc.constantFrom(...INSTALLERS),
  fromVersion: version,
  targetVersion: version,
  toVersion: fc.option(version, { nil: undefined }),
  error: fc.option(fc.constantFrom("The update exited with code 1.", "\n  boom\nmore"), { nil: undefined }),
}).map((input) => ({
  id: input.id,
  phase: input.phase,
  installer: input.installer,
  fromVersion: input.fromVersion,
  targetVersion: input.targetVersion,
  ...(input.toVersion ? { toVersion: input.toVersion } : {}),
  ...(input.error ? { error: input.error } : {}),
  startedAt: 1,
  updatedAt: 2,
}));

const state: fc.Arbitrary<CodexUserUpdateState> = fc.record({
  offer,
  run: fc.option(run, { nil: undefined }),
}).map((input) => ({
  ...(input.offer ? { offer: input.offer } : {}),
  ...(input.run ? { run: input.run } : {}),
}));

const dismissed = fc.uniqueArray(
  fc.oneof(
    version.map(codexUpdateOfferDismissKey),
    fc.integer({ min: 1, max: 5 }).map((id) => `run:${id}`),
  ),
  { maxLength: 4 },
).map((keys) => new Set(keys));

describe("Codex update pill", () => {
  it("always shows a running update, and it cannot be dismissed", () => {
    fc.assert(fc.property(state, dismissed, (current, keys) => {
      fc.pre(current.run !== undefined && CODEX_USER_UPDATE_ACTIVE_PHASES.has(current.run.phase));
      const view = buildCodexUpdatePillView(current, keys);
      expect(view?.tone).toBe("loading");
      expect(view?.dismissKeys).toEqual([]);
      expect(view?.action).toBeUndefined();
    }));
  });

  it("offers Update only when main can run it", () => {
    fc.assert(fc.property(state, dismissed, (current, keys) => {
      const view = buildCodexUpdatePillView(current, keys);
      if (view?.action?.kind === "update") {
        expect(current.offer?.canRunUpdate).toBe(true);
      }
    }));
  });

  it("goes away once dismissed and stays away for the same state", () => {
    fc.assert(fc.property(state, dismissed, (current, keys) => {
      const view = buildCodexUpdatePillView(current, keys);
      fc.pre(view !== undefined && view.dismissKeys.length > 0);
      const after = new Set([...keys, ...view!.dismissKeys]);
      const next = buildCodexUpdatePillView(current, after);
      // A finished run's dismissal also retires the offer for the release it
      // went after, so the pill does not ask again at once. Only an offer for
      // a different release may follow it.
      if (next) {
        expect(next.key).not.toBe(view!.key);
        expect(next.tone).toBe("available");
        expect(current.offer?.latestVersion).not.toBe(current.run?.targetVersion);
      }
    }));
  });

  it("shows nothing without an offer or a run", () => {
    expect(buildCodexUpdatePillView({}, new Set())).toBeUndefined();
    expect(buildCodexUpdatePillView(undefined, new Set())).toBeUndefined();
  });

  it("says which installer has nothing newer", () => {
    expect(buildCodexUpdatePillView({
      run: {
        id: 1,
        phase: "unchanged",
        installer: "homebrew",
        fromVersion: "0.172.0",
        targetVersion: "0.173.0",
        toVersion: "0.172.0",
        startedAt: 1,
        updatedAt: 2,
      },
    }, new Set())).toMatchObject({
      tone: "warning",
      title: "Codex is still 0.172.0",
      description: "Homebrew has no Codex 0.173.0 yet. Try again later.",
    });
  });

  it("copies the command when PwrAgent cannot run it", () => {
    expect(buildCodexUpdatePillView({
      offer: {
        installedVersion: "0.172.0",
        latestVersion: "0.173.0",
        installer: "bun",
        upgradeCommand: "bun add -g @openai/codex@latest",
        canRunUpdate: false,
      },
    }, new Set())?.action).toEqual({
      kind: "copy",
      label: "Copy command",
      command: "bun add -g @openai/codex@latest",
    });
  });
});
