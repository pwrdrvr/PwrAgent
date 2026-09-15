// Pins the pre-launch overlay seeder against the real overlay schema.
//
// `e2e/fixtures/overlay-state-seeding.ts` writes the `threads` table by hand,
// so it encodes two assumptions the app could change underneath it: the
// storage key the store reads a thread back by, and the overlay payload
// shape. If either drifts the seeder writes a row nothing reads, and the
// specs it feeds — branch drift, directory launchpad skills, provider model
// selectors — would fail with a missing dialog or an empty composer, naming
// neither the seed nor the encoding. Same failure mode, and same reasoning,
// as `sub-agent-state-seeding.test.ts`.
//
// It lives here rather than beside the fixture because `e2e/` is Playwright's
// `testDir` and its default `testMatch` claims `*.test.ts`; this needs vitest
// and a real sqlite file, and it costs no Electron launch.
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { seedProfileOverlayState } from "../../../e2e/fixtures/overlay-state-seeding";

function freshHomeRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "overlay-seed-"));
}

function openStore(homeRoot: string): SqliteOverlayStore {
  const dbPath = path.join(
    homeRoot,
    ".pwragent/profiles/default/state/state.db",
  );
  return new SqliteOverlayStore(StateDb.open(dbPath, { profileName: "default" }));
}

describe("seedProfileOverlayState", () => {
  it("creates the profile database when none exists yet", async () => {
    // Every consumer seeds before the first launch, so the seeder is what
    // materializes the profile directory and schema.
    const homeRoot = freshHomeRoot();

    await seedProfileOverlayState(homeRoot, {
      launchpadDefaults: {
        backend: "codex",
        executionMode: "full-access",
        workMode: "worktree",
      },
    });

    const defaults = await openStore(homeRoot).getLaunchpadDefaults();

    expect(defaults.backend).toBe("codex");
    expect(defaults.executionMode).toBe("full-access");
    expect(defaults.workMode).toBe("worktree");
  });

  it("reaches the overlay store with a thread the app can read back", async () => {
    // The branch-drift fixture's shape: the drift check compares the thread's
    // recorded `observedGitBranch` against the checkout's real branch, so a
    // row written under a key the store cannot resolve reads as no drift.
    const homeRoot = freshHomeRoot();

    await seedProfileOverlayState(homeRoot, {
      threads: [
        {
          backend: "codex",
          threadId: "thread-branch-drift",
          executionMode: "default",
          observedGitBranch: "codex/expected-branch",
          extraLinkedDirectories: [
            {
              id: "pwragent-handoff:codex:thread-branch-drift",
              kind: "worktree",
              label: "FixtureRepo",
              path: "/tmp/FixtureRepo",
              worktreePath: "/tmp/FixtureRepo",
            },
          ],
        },
      ],
    });

    const state = await openStore(homeRoot).getThreadOverlayState({
      backend: "codex",
      threadId: "thread-branch-drift",
    });

    expect(state?.observedGitBranch).toBe("codex/expected-branch");
    expect(state?.extraLinkedDirectories).toHaveLength(1);
    expect(state?.extraLinkedDirectories?.[0]?.worktreePath).toBe(
      "/tmp/FixtureRepo",
    );
  });

  it("registers a directory launchpad the store lists", async () => {
    // What `directory-launchpad-skills.spec.ts` depends on: the launchpad has
    // to come back with its saved prompt for the skill chip to render.
    const homeRoot = freshHomeRoot();
    const directoryKey = "directory:/tmp/FixtureRepo";

    await seedProfileOverlayState(homeRoot, {
      directoryLaunchpads: [
        {
          directoryKey,
          directoryKind: "directory",
          directoryLabel: "FixtureRepo",
          directoryPath: "/tmp/FixtureRepo",
          backend: "codex",
          executionMode: "full-access",
          prompt: "[$ce:brainstorm](/tmp/skills/ce-brainstorm/SKILL.md) ",
          workMode: "worktree",
          branchName: "main",
          createdAt: 1760000000000,
          updatedAt: 1760000000000,
        },
      ],
    });

    const launchpads = await openStore(homeRoot).listDirectoryLaunchpads();

    expect(launchpads).toHaveLength(1);
    expect(launchpads[0]?.directoryKey).toBe(directoryKey);
    expect(launchpads[0]?.prompt).toBe(
      "[$ce:brainstorm](/tmp/skills/ce-brainstorm/SKILL.md) ",
    );
  });
});
