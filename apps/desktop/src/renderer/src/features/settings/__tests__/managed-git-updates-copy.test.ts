import { describe, expect, it } from "vitest";
import type { DesktopManagedGitSnapshot } from "@pwragent/shared";
import {
  managedGitTrackOptions,
  managedGitUpdatesCopy,
  offeredManagedGitRelease,
} from "../managed-git-updates-copy";

const NOW = Date.UTC(2026, 10, 5, 16, 0);
// Prerelease, so the track adds nothing to the copy these cases pin.
const base: DesktopManagedGitSnapshot = {
  supported: true,
  bundledVersion: "2.56.0-dev-pwrgit.4",
  track: "prerelease",
  tracks: {},
  releases: [],
};
const release5 = {
  generation: "2.56.0-dev-pwrgit.5-1a2b3c4",
  version: "2.56.0-dev-pwrgit.5",
  tag: "v2.56.0-dev-pwrgit.5",
  executable: "/x/bin/git",
  installedAt: NOW,
};
const available5 = { tag: release5.tag, version: release5.version, generation: release5.generation, archiveBytes: 38_890_030 };
const copy = (managed: Partial<DesktopManagedGitSnapshot>, manualPathSelected = false) =>
  managedGitUpdatesCopy({ ...base, ...managed }, { now: NOW, manualPathSelected });
const kinds = (result: ReturnType<typeof copy>) => result.actions.map((action) => `${action.kind}${action.primary ? "!" : ""}`);

describe("Settings → Git → Updates", () => {
  it("says the bundle is current after a check", () => {
    const result = copy({ check: { checkedAt: NOW - 2 * 60_000 } });
    expect(result.tag).toBe("2.56.0-dev-pwrgit.4");
    expect(result.message).toBe("is the newest PwrDrvr Git. Checked 2 minutes ago.");
    expect(kinds(result)).toEqual(["check"]);
  });

  it("offers a download, never a switch, for a newer release", () => {
    const result = copy({ check: { checkedAt: NOW, available: available5 } });
    expect(result.tag).toBe("2.56.0-dev-pwrgit.5");
    expect(result.message).toBe("is available (37 MB). Bundled: 2.56.0-dev-pwrgit.4.");
    expect(result.note).toBe("Downloading does not switch Git. You choose when to use it.");
    expect(kinds(result)).toEqual(["download!", "check"]);
  });

  it("offers Use once the release is downloaded, even while a manual path stays selected", () => {
    const result = copy({ check: { checkedAt: NOW, available: available5 }, releases: [release5] }, true);
    expect(result.message).toBe("is downloaded and verified. Not in use yet.");
    expect(result.actions[0]).toMatchObject({ kind: "use", generation: release5.generation, primary: true });
  });

  it("offers Roll back to exactly the Git it replaced", () => {
    const result = copy({
      selected: release5.generation,
      releases: [release5],
      previous: { kind: "path", path: "/usr/local/bin/git" },
      check: { checkedAt: NOW, available: available5 },
    });
    expect(result.message).toMatch(/^is in use\./u);
    expect(result.note).toBe("Commands already running finish on the Git they started with.");
    expect(result.actions.at(-1)).toMatchObject({ kind: "rollback", label: "Roll back to Custom path", choice: { kind: "path", path: "/usr/local/bin/git" } });
  });

  it("puts Roll back first when the chosen release failed its checks", () => {
    const result = copy({
      selected: release5.generation,
      releases: [{ ...release5, failure: "A file changed after the release was sealed: bin/git" }],
      previous: { kind: "bundled" },
    });
    expect(result.tone).toBe("error");
    expect(result.tag).toBe("2.56.0-dev-pwrgit.5");
    expect(result.message).toBe(
      "Failed verification: A file changed after the release was sealed: bin/git. Git commands fail until you choose another Git.",
    );
    expect(result.actions).toEqual([
      expect.objectContaining({ kind: "rollback", primary: true, label: "Roll back to Bundled 2.56.0-dev-pwrgit.4" }),
    ]);
  });

  it("names a chosen release that is no longer installed", () => {
    const result = copy({ selected: release5.generation, previous: { kind: "bundled" } });
    expect(result.tag).toBe(release5.generation);
    expect(result.message).toBe("is no longer installed. Git commands fail until you choose another Git.");
  });

  it("reports an offline check without hiding installed releases", () => {
    const result = copy({ releases: [release5], check: { checkedAt: NOW, error: "GitHub could not be reached." } });
    expect(result.tone).toBe("notice");
    expect(result.note).toBe("Could not check for updates: GitHub could not be reached. Installed builds still work.");
  });

  it("names a release that needs a newer PwrAgent and offers no download for it", () => {
    const result = copy({ check: { checkedAt: NOW, needsAppUpdate: { version: "2.56.0-dev-pwrgit.6" } } });
    expect(result.note).toBe("2.56.0-dev-pwrgit.6 needs a newer PwrAgent. Update PwrAgent to use it.");
    expect(kinds(result)).toEqual(["check"]);
  });
});

const releaseOf = (n: number) => ({
  generation: `2.56.0-dev-pwrgit.${n}-1a2b3c${n}`,
  version: `2.56.0-dev-pwrgit.${n}`,
  tag: `v2.56.0-dev-pwrgit.${n}`,
  executable: `/x/${n}/bin/git`,
  installedAt: NOW,
});
const availableOf = (n: number) => {
  const release = releaseOf(n);
  return { tag: release.tag, version: release.version, generation: release.generation };
};

describe("Settings → Git → Build track", () => {
  it("offers a build exactly when it is newer than the build in use", () => {
    // Oracle: build numbers on one base version, ordered as plain integers,
    // never through the comparator under test. 4 is the bundle.
    for (const track of ["latest", "prerelease"] as const) {
      for (const offered of [5, 6, 7, 8, 9, 10, 11]) {
        for (const inUse of [undefined, 5, 6, 7, 8, 9, 10, 11]) {
          for (const manual of [false, true]) {
            const managed: DesktopManagedGitSnapshot = {
              ...base,
              track,
              releases: inUse ? [releaseOf(inUse)] : [],
              ...(inUse ? { selected: releaseOf(inUse).generation } : {}),
              check: { checkedAt: NOW, available: availableOf(offered) },
            };
            const running = manual || inUse === undefined ? 4 : inUse;
            const label = JSON.stringify({ track, offered, inUse, manual });
            expect(offeredManagedGitRelease(managed, manual)?.version, label)
              .toBe(offered > running ? `2.56.0-dev-pwrgit.${offered}` : undefined);
            const actions = managedGitUpdatesCopy(managed, { now: NOW, manualPathSelected: manual }).actions;
            // A downloaded build is offered as Use, a new one as Download.
            const offersBuild = actions.some((action) => action.kind === "download" || action.kind === "use");
            expect(offersBuild, label).toBe(offered > running);
          }
        }
      }
    }
  });

  it("never offers an older promoted build over a newer prerelease build in use", () => {
    const result = copy({
      track: "latest",
      tracks: { latestTag: "2.56.0-dev-pwrgit.5", prereleaseTag: "2.56.0-dev-pwrgit.6" },
      releases: [releaseOf(6)],
      selected: releaseOf(6).generation,
      check: { checkedAt: NOW, available: availableOf(5), needsAppUpdate: { version: "2.56.0-dev-pwrgit.5" } },
    });
    expect(result.tag).toBe("2.56.0-dev-pwrgit.6");
    expect(result.message).toMatch(/^is in use\./u);
    expect(kinds(result)).toEqual(["check"]);
    expect(result.note).toBe("Commands already running finish on the Git they started with.");
  });

  it("says what Prerelease offers while Latest has nothing promoted", () => {
    const result = copy({
      track: "latest",
      tracks: { prereleaseTag: "2.56.0-dev-pwrgit.5" },
      check: { checkedAt: NOW - 60 * 60_000 },
    });
    expect(result.message).toBe("is the newest promoted PwrDrvr Git. Checked 1 hour ago.");
    expect(result.note).toBe("Prerelease offers 2.56.0-dev-pwrgit.5, not yet promoted.");
    expect(kinds(result)).toEqual(["check"]);
  });

  it("labels each track with the version it offers, or the bundle once checked", () => {
    const options = (managed: Partial<DesktopManagedGitSnapshot>) =>
      managedGitTrackOptions({ ...base, ...managed }).map((option) => `${option.value}:${option.meta}`);
    expect(options({})).toEqual(["latest:Unavailable", "prerelease:Unavailable"]);
    expect(options({ check: { checkedAt: NOW }, tracks: { prereleaseTag: "2.56.0-dev-pwrgit.5" } }))
      .toEqual(["latest:2.56.0-dev-pwrgit.4", "prerelease:2.56.0-dev-pwrgit.5"]);
  });
});
