import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertSafeWorkspaceParent,
  defaultSafeWorkspaceParent,
  isWithinPath,
  resolveRefusedWorkspaceRoots,
  resolveSafeWorkspaceParent,
} from "../../shared/workspace-staging.mjs";

const safeSegment = fc.stringMatching(/^[a-z0-9_-]{1,16}$/);

describe("eval workspace staging safety", () => {
  it("rejects workspaces staged inside ~/.codex/worktrees (Outpost sandbox guard counterexample)", () => {
    const fakeHome = "/tmp/eval-fake-home";
    const codexWorktreeStaging = path.join(fakeHome, ".codex", "worktrees", "mwxx1px5", "PwrAgnt", ".local", "eval");
    expect(() =>
      assertSafeWorkspaceParent(codexWorktreeStaging, {
        hostHome: fakeHome,
        env: { CODEX_HOME: path.join(fakeHome, ".codex") },
      }),
    ).toThrow(/overlaps refused root/i);
  });

  it("rejects workspaces inside any CODEX_HOME or PWRAGENT_HOME/profiles subtree (property)", () => {
    fc.assert(
      fc.property(
        fc.array(safeSegment, { minLength: 1, maxLength: 4 }),
        (segments) => {
          const hostHome = "/tmp/eval-prop-home";
          const codexHome = path.join(hostHome, ".codex");
          const pwragentHome = "/tmp/eval-prop-pwragent";
          const opts = { hostHome, pwragentHome, env: { CODEX_HOME: codexHome } };

          const underCodex = path.join(codexHome, ...segments);
          expect(() => assertSafeWorkspaceParent(underCodex, opts)).toThrow(/overlaps refused root/i);

          const underProfiles = path.join(pwragentHome, "profiles", ...segments);
          expect(() => assertSafeWorkspaceParent(underProfiles, opts)).toThrow(/overlaps refused root/i);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("always chooses a default staging root disjoint from CODEX_HOME and PWRAGENT_HOME/profiles", () => {
    const hostHome = "/Users/example-operator";
    const pwragentHome = "/Users/example-operator/.pwragent";
    const env = { CODEX_HOME: "/Users/example-operator/.codex" };
    const chosen = resolveSafeWorkspaceParent({ hostHome, pwragentHome, env, platform: "darwin" });
    const refused = resolveRefusedWorkspaceRoots({ hostHome, pwragentHome, env });
    for (const root of refused) {
      expect(isWithinPath(chosen, root)).toBe(false);
      expect(isWithinPath(root, chosen)).toBe(false);
    }
    expect(chosen).toBe(defaultSafeWorkspaceParent({ platform: "darwin" }));
  });
});
