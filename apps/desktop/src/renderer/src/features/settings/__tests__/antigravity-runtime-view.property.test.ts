import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareAntigravityVersions } from "../../../../../shared/antigravity-setup";
import {
  antigravityRuntimeView,
  antigravityUpdateNoticeVersion,
} from "../antigravity-runtime-view";

const ROOT = "/Users/contrived/.pwragent/agents/antigravity";
const arbTuple = fc.tuple(fc.nat({ max: 40 }), fc.nat({ max: 40 }), fc.nat({ max: 40 }));
const format = ([major, minor, patch]: [number, number, number]) => `${major}.${minor}.${patch}`;
const managedCommand = (version: string) => `${ROOT}/versions/${version}-${"a".repeat(128)}/agy`;

/** Oracle: compare the numeric tuples left to right. */
function tupleOrder(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

describe("Antigravity version order", () => {
  it("matches numeric tuple order, whichever side is asked first", () => {
    fc.assert(fc.property(arbTuple, arbTuple, (left, right) => {
      expect(compareAntigravityVersions(format(left), format(right))).toBe(tupleOrder(left, right));
      expect(compareAntigravityVersions(format(right), format(left))).toBe(-tupleOrder(left, right));
    }));
  });

  it("orders patch 10 after patch 9, not as text", () => {
    expect(compareAntigravityVersions("1.5.10", "1.5.9")).toBe(1);
  });
});

describe("Antigravity runtime view", () => {
  it("offers an update exactly when Google names a newer release than the managed install", () => {
    fc.assert(fc.property(arbTuple, arbTuple, fc.boolean(), (installed, latest, inUse) => {
      const version = format(installed);
      const command = managedCommand(version);
      const view = antigravityRuntimeView({
        runtime: { status: "installed", runtime: { command, version } },
        release: { latestVersion: format(latest), checkedAt: 1 },
        entry: { enabled: true, installed: true, activeCommand: inUse ? command : "/opt/contrived/agy" },
      });
      expect(view.kind).toBe("installed");
      if (view.kind !== "installed") return;
      expect(view.updateAvailable).toBe(tupleOrder(latest, installed) > 0);
      // The startup notice is the same rule, limited to a managed install
      // that new threads actually run.
      expect(antigravityUpdateNoticeVersion(view)).toBe(
        inUse && tupleOrder(latest, installed) > 0 ? format(latest) : undefined,
      );
    }));
  });

  it("never offers an update without a managed install; that state offers Install", () => {
    fc.assert(fc.property(arbTuple, fc.option(fc.string(), { nil: undefined }), (latest, detected) => {
      const view = antigravityRuntimeView({
        runtime: { status: "not-installed" },
        release: { latestVersion: format(latest), checkedAt: 1 },
        entry: { installed: detected !== undefined, version: detected },
      });
      expect(view.kind).toBe("not-installed");
      expect(antigravityUpdateNoticeVersion(view)).toBeUndefined();
    }));
    const unsupported = antigravityRuntimeView({ runtime: { status: "unsupported" } });
    expect(unsupported).toEqual({ kind: "unsupported" });
    expect(antigravityUpdateNoticeVersion(unsupported)).toBeUndefined();
  });

  it("counts the managed install as in use under its active link too, and not while disabled", () => {
    const runtime = { status: "installed" as const, runtime: { command: managedCommand("1.5.15"), version: "1.5.15" } };
    const release = { latestVersion: "1.5.16", checkedAt: 1 };
    const viaLink = antigravityRuntimeView({ runtime, release, entry: { enabled: true, activeCommand: `${ROOT}/active` } });
    expect(viaLink).toMatchObject({ kind: "installed", inUse: true, updateAvailable: true });
    expect(antigravityUpdateNoticeVersion(viaLink)).toBe("1.5.16");
    expect(antigravityUpdateNoticeVersion(viaLink, "1.5.16")).toBeUndefined();
    const disabled = antigravityRuntimeView({
      runtime,
      release,
      entry: { enabled: false, activeCommand: runtime.runtime.command },
    });
    expect(antigravityUpdateNoticeVersion(disabled)).toBeUndefined();
  });

  it("says nothing about updates before a release check has answered", () => {
    const command = managedCommand("1.5.15");
    const view = antigravityRuntimeView({
      runtime: { status: "installed", runtime: { command, version: "1.5.15" } },
      entry: { enabled: true, activeCommand: command },
    });
    expect(view).toMatchObject({ kind: "installed", inUse: true, updateAvailable: false });
    expect(view).not.toHaveProperty("latestVersion");
  });
});
