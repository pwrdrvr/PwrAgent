import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  combineCodexAppServerRolloverOutcomes,
  decideCodexInstallationChange,
  type CodexAppServerRolloverOutcome,
} from "@pwragent/owner-core/codex-app-server/app-server-installation";
import { readCodexExecutableIdentity, type CodexExecutableIdentity } from "../codex-app-server/executable-identity";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A Homebrew prefix laid out like the cask: bin/codex links into Caskroom. */
async function homebrewPrefix() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-codex-install-"));
  roots.push(root);
  const link = path.join(root, "bin", "codex");
  await mkdir(path.dirname(link), { recursive: true });
  const installVersion = async (version: string) => {
    const bin = path.join(root, "Caskroom", "codex", version, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "codex"), `#!/bin/sh\necho codex-cli ${version}\n`, { mode: 0o755 });
    await writeFile(path.join(bin, "codex-code-mode-host"), "#!/bin/sh\n", { mode: 0o755 });
    return path.join(bin, "codex");
  };
  return { root, link, installVersion };
}

describe("Codex installation identity", () => {
  it("detects a Homebrew upgrade that deleted the running version's companion helpers", async () => {
    const prefix = await homebrewPrefix();
    const old = await prefix.installVersion("0.160.0");
    await symlink(old, prefix.link);
    const launched = await readCodexExecutableIdentity(prefix.link, "0.160.0");
    const hostBesideLaunched = path.join(path.dirname(launched.realPath!), "codex-code-mode-host");
    expect(existsSync(hostBesideLaunched)).toBe(true);

    // `brew upgrade`: install the new version, repoint the link, delete the old.
    const next = await prefix.installVersion("0.161.0");
    await unlink(prefix.link);
    await symlink(next, prefix.link);
    await rm(path.join(prefix.root, "Caskroom", "codex", "0.160.0"), { recursive: true });

    // A process launched earlier would look for its helper here: it is gone,
    // and no fail-open fallback can bring it back. Only a new launch can.
    expect(existsSync(hostBesideLaunched)).toBe(false);
    const now = await readCodexExecutableIdentity(prefix.link);
    expect(decideCodexInstallationChange(launched, now)).toBe("executable-moved");
    expect(existsSync(path.join(path.dirname(now.realPath!), "codex-code-mode-host"))).toBe(true);
  });

  it("detects an in-place replacement (npm, app bundle) and a deleted executable", async () => {
    const prefix = await homebrewPrefix();
    const file = path.join(prefix.root, "codex");
    await writeFile(file, "#!/bin/sh\necho one\n", { mode: 0o755 });
    const launched = await readCodexExecutableIdentity(file);
    expect(decideCodexInstallationChange(launched, await readCodexExecutableIdentity(file))).toBeUndefined();

    await rm(file);
    expect(decideCodexInstallationChange(launched, await readCodexExecutableIdentity(file))).toBe("executable-missing");
    await writeFile(file, "#!/bin/sh\necho a longer replacement\n", { mode: 0o755 });
    expect(decideCodexInstallationChange(launched, await readCodexExecutableIdentity(file))).toBe("executable-replaced");
  });

  it("has nothing to compare for a bare command resolved through PATH", async () => {
    const identity = await readCodexExecutableIdentity("codex");
    expect(identity).toEqual({ command: "codex" });
    expect(decideCodexInstallationChange(identity, identity)).toBeUndefined();
  });

  it("reports a change exactly when the same command now names a different or missing file", () => {
    const field = fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined });
    const identity = fc.record({
      command: fc.constantFrom("/opt/homebrew/bin/codex", "/usr/local/bin/codex"),
      realPath: fc.option(fc.constantFrom("/a/codex", "/b/codex"), { nil: undefined }),
      dev: field,
      ino: field,
      size: field,
      mtimeMs: field,
    }, { requiredKeys: ["command"] }) as fc.Arbitrary<CodexExecutableIdentity>;
    fc.assert(fc.property(identity, identity, (launched, current) => {
      const decision = decideCodexInstallationChange(launched, current);
      // Oracle: spelled out case by case, without the implementation's shortcuts.
      const comparable = Boolean(launched.realPath) && launched.command === current.command;
      const known = (key: "dev" | "ino" | "size" | "mtimeMs") =>
        launched[key] !== undefined && current[key] !== undefined && launched[key] !== current[key];
      const expected = !comparable ? undefined
        : current.realPath === undefined ? "executable-missing"
          : current.realPath !== launched.realPath ? "executable-moved"
            : (["dev", "ino", "size", "mtimeMs"] as const).some(known) ? "executable-replaced"
              : undefined;
      expect(decision).toBe(expected);
    }), { numRuns: 500 });
  });

  it("applies a selection only when every runtime applied it (oracle)", () => {
    const outcome: fc.Arbitrary<CodexAppServerRolloverOutcome> = fc.oneof(
      fc.record({ kind: fc.constant("promoted" as const), generation: fc.integer({ min: 1, max: 9 }) }),
      fc.constant({ kind: "restarted-lazily" as const }),
      fc.constant({ kind: "current" as const }),
      fc.record({ kind: fc.constant("failed" as const), error: fc.constantFrom("a", "b") }),
      fc.record({ kind: fc.constant("deferred" as const), retryAt: fc.integer({ min: 0, max: 9 }) }),
    );
    fc.assert(fc.property(fc.array(outcome, { maxLength: 6 }), (outcomes) => {
      const combined = combineCodexAppServerRolloverOutcomes(outcomes);
      const kinds = new Set(outcomes.map((entry) => entry.kind));
      const applied = !kinds.has("failed") && !kinds.has("deferred");
      expect(combined.kind === "failed" || combined.kind === "deferred").toBe(!applied);
      if (kinds.has("failed")) expect(combined.kind).toBe("failed");
      else if (kinds.has("deferred")) {
        // Retry no sooner than the last runtime allows.
        expect(combined).toEqual({ kind: "deferred", retryAt: Math.max(
          ...outcomes.flatMap((entry) => entry.kind === "deferred" ? [entry.retryAt] : []),
        ) });
      } else if (kinds.has("promoted")) expect(combined.kind).toBe("promoted");
      else if (kinds.has("restarted-lazily")) expect(combined.kind).toBe("restarted-lazily");
      else expect(combined).toEqual({ kind: "current" });
    }), { numRuns: 300 });
  });
});
