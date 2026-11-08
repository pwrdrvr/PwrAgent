import fc from "fast-check";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { NavigationPreferencesStorage } from "@pwragent/owner-core/navigation-preferences-storage";
import type { ProfileBootDecision } from "../profile";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { getDesktopNavigationPreferencesStorage } from "../storage/desktop-overlay-store";
import { readBootstrapNavigationPreferences, parseBootstrapNavigationPreferencesArg, navigationPreferencesAdditionalArguments } from "../navigation-browse-mode-bootstrap";
import { buildBootInfo, isBootstrapProfile } from "../profile-service";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({
  overlay: undefined as SqliteOverlayStore | undefined,
  mode: null as "bootstrap" | "active-profile" | null,
  decision: null as ProfileBootDecision | null,
  profile: "fixture",
  pinnedOnTop: true,
}));
vi.mock("../state/app-state", () => ({
  getAppOverlayStore: () => {
    if (!active.overlay) throw new Error("App state not initialized");
    return active.overlay;
  },
  getAppStateMode: () => active.mode,
  getBootDecision: () => active.decision,
}));
vi.mock("../settings/config-store/desktop-config-store-singleton", () => ({
  getExistingDesktopConfigStore: () => ({ read: () => ({ settings: { pinnedThreadsOnTop: active.pinnedOnTop } }) }),
}));
vi.mock("../profile", async (original) => ({
  ...await original<typeof import("../profile")>(),
  resolveActiveProfileName: () => active.profile,
}));

afterEach(() => {
  active.overlay = undefined;
  active.mode = null;
  active.decision = null;
  vi.unstubAllEnvs();
});

it("reads navigation from the current profile synchronously, without writes or cached handles", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  expectTypeOf<ReturnType<typeof getDesktopNavigationPreferencesStorage>>().toEqualTypeOf<NavigationPreferencesStorage>();
  const operation = fc.record({
    profile: fc.integer({ min: 0, max: 1 }),
    mode: fc.constantFrom("attention", "drafts", "inbox", "recents", "directories"),
    collapsed: fc.boolean(), pinnedOnTop: fc.boolean(), initialized: fc.boolean(),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 20 }), async (operations) => {
    const databases = [openInMemoryStateDb(), openInMemoryStateDb()];
    const stores = databases.map(db => new SqliteOverlayStore(db));
    try {
      for (const op of operations) {
        const store = stores[op.profile]!;
        await store.setNavigationBrowseMode(op.mode);
        await store.setPinnedGroupCollapsed(op.collapsed);
        active.overlay = op.initialized ? store : undefined;
        active.pinnedOnTop = op.pinnedOnTop;
        const read = await measureSqliteWrites(() => {
          const preferences = readBootstrapNavigationPreferences();
          expect(preferences).toEqual({
            browseMode: op.initialized ? op.mode : "inbox",
            ...(op.initialized ? { resumeState: undefined } : {}),
            pinnedGroupCollapsed: op.initialized && op.collapsed,
            pinnedThreadsOnTop: op.pinnedOnTop,
          });
          expect(parseBootstrapNavigationPreferencesArg(navigationPreferencesAdditionalArguments(preferences))).toEqual({ ...preferences, resumeState: undefined });
        });
        expect(read.writes.commits).toBe(0);
      }
    } finally {
      active.overlay = undefined;
      for (const db of databases) db.close();
    }
  }), { numRuns: 25 });
});

it("projects the recorded boot decision independently of the subsequently selected profile", () => {
  const decision = fc.oneof(
    fc.constant(null),
    fc.record({ kind: fc.constant("open" as const), profileName: fc.string(), profileDir: fc.string(), source: fc.constant("env" as const) }),
    fc.record({ kind: fc.constant("missing-named-profile" as const), requestedName: fc.string(), source: fc.constant("cli" as const) }),
    fc.record({ kind: fc.constant("missing-default-profile" as const), configuredName: fc.string() }),
    fc.constant({ kind: "no-profile-configured" as const }),
  );
  fc.assert(fc.property(decision, fc.boolean(), fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/), (boot, initialized, profile) => {
    const mode = !boot || !initialized ? null : boot.kind === "open" ? "active-profile" : "bootstrap";
    active.decision = boot;
    active.mode = mode;
    active.profile = profile;
    const info = buildBootInfo();
    expect(isBootstrapProfile()).toBe(mode === "bootstrap");
    expect(info.mode).toBe(mode ?? "active-profile");
    expect(info.decisionKind).toBe(boot?.kind ?? "open");
    if (boot?.kind === "missing-named-profile") expect(info.requestedProfileName).toBe(boot.requestedName);
    else if (boot?.kind === "missing-default-profile") expect(info.configuredDefaultName).toBe(boot.configuredName);
    else if (!boot || boot.kind === "open") expect(info.activeProfileName).toBe(mode === "bootstrap" ? undefined : profile);
  }));
});
