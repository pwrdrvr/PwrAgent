import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopGitRuntimeChoice } from "@pwragent/shared";
import {
  currentGitRuntimeChoice,
  decodeGitRuntimeChoice,
  encodeGitRuntimeChoice,
  gitRuntimeSelectionPatch,
  readProfileManagedGitSelections,
} from "../settings/managed-git-selection";
import { makeRoot } from "./helpers/managed-git-fixture";

type Stored = { path?: string; managed?: string; managedPrevious?: string };

const choice: fc.Arbitrary<DesktopGitRuntimeChoice> = fc.oneof(
  fc.constant({ kind: "bundled" as const }),
  fc.constantFrom("5-aaaaaaa", "6-bbbbbbb", "7-ccccccc").map((suffix) => ({
    kind: "managed" as const,
    generation: `2.56.0-dev-pwrgit.${suffix}`,
  })),
  fc.constantFrom("/opt/homebrew/bin/git", "/usr/bin/git", "/Users/example/git builds/bin/git").map((p) => ({
    kind: "path" as const,
    path: p,
  })),
);

/** What Settings writes for one explicit selection. */
function select(stored: Stored, next: DesktopGitRuntimeChoice): Stored {
  return { ...stored, ...gitRuntimeSelectionPatch(currentGitRuntimeChoice(stored), next) };
}

function rollback(stored: Stored): Stored {
  const previous = decodeGitRuntimeChoice(stored.managedPrevious);
  return previous ? select(stored, previous) : stored;
}

describe("Git selection model", () => {
  it("makes the chosen Git current and the one it replaced the roll-back target", () => {
    fc.assert(fc.property(fc.array(choice, { maxLength: 12 }), choice, (history, next) => {
      const before = history.reduce(select, {} as Stored);
      const prior = currentGitRuntimeChoice(before);
      const after = select(before, next);
      expect(currentGitRuntimeChoice(after)).toEqual(next);
      if (encodeGitRuntimeChoice(prior) === encodeGitRuntimeChoice(next)) {
        // Re-selecting the current Git keeps the roll-back target.
        expect(after.managedPrevious).toBe(before.managedPrevious);
      } else {
        expect(decodeGitRuntimeChoice(after.managedPrevious)).toEqual(prior);
        // Roll back returns exactly to what was running before.
        expect(currentGitRuntimeChoice(rollback(after))).toEqual(prior);
      }
    }));
  });

  it("round-trips every choice through its stored form", () => {
    fc.assert(fc.property(choice, (value) => {
      expect(decodeGitRuntimeChoice(encodeGitRuntimeChoice(value))).toEqual(value);
    }));
    expect(decodeGitRuntimeChoice("managed:../../etc")).toBeUndefined();
    expect(decodeGitRuntimeChoice("path:")).toBeUndefined();
  });

  it("keeps a manual path ahead of a downloaded release, as Git resolution does", () => {
    expect(currentGitRuntimeChoice({ path: "/usr/bin/git", managed: "2.56.0-dev-pwrgit.5-aaaaaaa" }))
      .toEqual({ kind: "path", path: "/usr/bin/git" });
    expect(currentGitRuntimeChoice({ path: " ", managed: "2.56.0-dev-pwrgit.5-aaaaaaa" }))
      .toEqual({ kind: "managed", generation: "2.56.0-dev-pwrgit.5-aaaaaaa" });
    expect(currentGitRuntimeChoice({ managed: "not-a-release" })).toEqual({ kind: "bundled" });
  });
});

describe("releases other profiles name", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("collects every profile's current release and roll-back release, and ignores unreadable configs", () => {
    const root = makeRoot();
    roots.push(root);
    const write = (profile: string, body: string) => {
      mkdirSync(path.join(root, "profiles", profile), { recursive: true });
      writeFileSync(path.join(root, "profiles", profile, "config.toml"), body);
    };
    write("default", '[applications.git]\nmanaged = "2.56.0-dev-pwrgit.5-aaaaaaa"\n');
    write("work", '[applications.git]\npath = "/usr/bin/git"\nmanaged_previous = "managed:2.56.0-dev-pwrgit.6-bbbbbbb"\n');
    write("broken", "[applications.git\nmanaged = ");
    mkdirSync(path.join(root, "profiles", "empty"), { recursive: true });
    expect([...readProfileManagedGitSelections(root)].sort()).toEqual([
      "2.56.0-dev-pwrgit.5-aaaaaaa",
      "2.56.0-dev-pwrgit.6-bbbbbbb",
    ]);
  });
});
