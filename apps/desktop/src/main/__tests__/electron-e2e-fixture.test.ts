import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOnboardingSeedTook,
  closeElectronApplication,
  configureElectronE2eSecretStorageEnv,
  nextRendererViewportRequest,
  raceTeardownTimeout,
  resolveSeedConfigPath,
  waitForRendererReady,
} from "../../../e2e/fixtures/electron-app";
import { applyDesktopSettingsPatch } from "../settings/desktop-config";
import {
  E2E_MEMORY_SECRET_STORAGE_ENV,
  SECRET_STORAGE_DISABLED_ENV,
} from "../settings/desktop-secret-store";

describe("Electron E2E fixture teardown", () => {
  it("is a no-op after Playwright has already disposed a graduated bootstrap app", async () => {
    const electronApp = {
      process: vi.fn(() => {
        throw new TypeError("Cannot read properties of undefined");
      }),
    };

    await expect(
      closeElectronApplication(electronApp as never),
    ).resolves.toBeUndefined();
  });

  it("keeps keychain access disabled while enabling writable screenshot storage", () => {
    const env: Record<string, string> = {};

    configureElectronE2eSecretStorageEnv(env, "memory");

    expect(env).toMatchObject({
      [E2E_MEMORY_SECRET_STORAGE_ENV]: "1",
      [SECRET_STORAGE_DISABLED_ENV]: "1",
    });

    configureElectronE2eSecretStorageEnv(env);

    expect(env[SECRET_STORAGE_DISABLED_ENV]).toBe("1");
    expect(env[E2E_MEMORY_SECRET_STORAGE_ENV]).toBeUndefined();
  });

  it("compensates a near-target renderer size exactly", () => {
    expect(
      nextRendererViewportRequest({
        attempt: 0,
        observed: { innerWidth: 1439, innerHeight: 901 },
        previousRequest: null,
        target: { width: 1440, height: 900 },
      }),
    ).toEqual({ width: 1441, height: 899 });
  });

  it("nudges stale far-from-target resizes without feeding back a large error", () => {
    expect(
      nextRendererViewportRequest({
        attempt: 1,
        observed: { innerWidth: 1200, innerHeight: 760 },
        previousRequest: { width: 1440, height: 900 },
        target: { width: 1440, height: 900 },
      }),
    ).toEqual({ width: 1440, height: 901 });
  });

  it("forces a real native frame change when compensation repeats", () => {
    expect(
      nextRendererViewportRequest({
        attempt: 1,
        observed: { innerWidth: 1439, innerHeight: 901 },
        previousRequest: { width: 1441, height: 899 },
        target: { width: 1440, height: 900 },
      }),
    ).toEqual({ width: 1441, height: 898 });
  });
});

// A blocked onboarding wizard used to present as twenty identical
// `Worker teardown timeout of 30000ms exceeded` lines and a 20-minute
// job burn, with nothing in the output naming onboarding. These lock the
// pre-launch checks that turn that into a one-second, self-describing
// failure — and, just as importantly, that they stay quiet on the happy
// path so no spec pays a false positive.
describe("Electron E2E onboarding-suppression seed", () => {
  const roots: string[] = [];

  function makeHomeRoot(): string {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-seed-assert-"),
    );
    roots.push(root);
    return root;
  }

  function seed(configPath: string, completed: boolean): void {
    applyDesktopSettingsPatch(configPath, {
      general: { appearance: { theme: "dark" } },
      onboarding: { completed },
    });
  }

  afterEach(() => {
    while (roots.length > 0) {
      fs.rmSync(roots.pop() as string, { recursive: true, force: true });
    }
  });

  it("follows PWRAGENT_HOME and PWRAGENT_PROFILE to the config the app will read", () => {
    const pwragentRoot = makeHomeRoot();
    const env = {
      HOME: makeHomeRoot(),
      PWRAGENT_HOME: pwragentRoot,
      PWRAGENT_PROFILE: "ghost",
    };

    expect(resolveSeedConfigPath(env)).toBe(
      path.join(pwragentRoot, "profiles", "ghost", "config.toml"),
    );
  });

  it("passes once the seed has landed in that profile", () => {
    const env = { HOME: makeHomeRoot() };
    const seedConfigPath = resolveSeedConfigPath(env);
    seed(seedConfigPath, true);

    expect(() =>
      assertOnboardingSeedTook({ env, seedConfigPath }),
    ).not.toThrow();
  });

  it("names the wizard when no profile exists for the app to open", () => {
    const env = { HOME: makeHomeRoot() };
    const seedConfigPath = resolveSeedConfigPath(env);

    expect(() => assertOnboardingSeedTook({ env, seedConfigPath })).toThrow(
      /onboarding wizard[\s\S]*no-profile-configured/,
    );
  });

  it("names the wizard when PWRAGENT_PROFILE points at a profile that was never created", () => {
    const env = { HOME: makeHomeRoot(), PWRAGENT_PROFILE: "ghost" };
    const seedConfigPath = resolveSeedConfigPath(env);
    // The seed lands in `profiles/ghost/`, so the profile now exists and
    // the boot decision is `open` — this is the case the old hardcoded
    // `profiles/default/config.toml` path got wrong.
    seed(seedConfigPath, true);

    expect(() =>
      assertOnboardingSeedTook({ env, seedConfigPath }),
    ).not.toThrow();
    expect(() =>
      assertOnboardingSeedTook({
        env,
        seedConfigPath: path.join(
          env.HOME,
          ".pwragent/profiles/default/config.toml",
        ),
      }),
    ).toThrow(/seed did not take[\s\S]*read back as undefined/);
  });

  it("names the seed when the profile opens but onboarding.completed is not true", () => {
    const env = { HOME: makeHomeRoot() };
    const seedConfigPath = resolveSeedConfigPath(env);
    seed(seedConfigPath, false);

    expect(() => assertOnboardingSeedTook({ env, seedConfigPath })).toThrow(
      /seed did not take/,
    );
  });

  // `parseDesktopSettingsToml` is strict — a truncated write throws
  // rather than falling back to defaults — but a bare "Invalid TOML"
  // says nothing about which harness step produced the file.
  it("names the seed when a partially written config.toml fails to parse", () => {
    const env = { HOME: makeHomeRoot() };
    const seedConfigPath = resolveSeedConfigPath(env);
    seed(seedConfigPath, true);
    fs.writeFileSync(seedConfigPath, "[onboarding\ncompleted = tru", "utf8");

    expect(() => assertOnboardingSeedTook({ env, seedConfigPath })).toThrow(
      /seed did not take[\s\S]*Invalid TOML/,
    );
  });

  it("reports the paths and env that decided the profile", () => {
    const env = { HOME: makeHomeRoot() };
    const seedConfigPath = resolveSeedConfigPath(env);

    expect(() => assertOnboardingSeedTook({ env, seedConfigPath })).toThrow(
      new RegExp(
        [
          `seeded config: +${seedConfigPath.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&")}`,
          `HOME: +${env.HOME.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&")}`,
          "PWRAGENT_HOME: +\\(unset\\)",
          "PWRAGENT_PROFILE: +\\(unset\\)",
        ].join("[\\s\\S]*"),
      ),
    );
  });

  // Following the production resolvers means inheriting their fallback
  // to `os.homedir()`. Right for the app; for a fixture it would seed
  // the operator's real ~/.pwragent, so the harness refuses instead.
  it("refuses to resolve a seed path when HOME is missing from the launch env", () => {
    expect(() => resolveSeedConfigPath({} as Record<string, string>)).toThrow(
      /no HOME[\s\S]*operator's real/,
    );
  });
});

// The pre-launch checks above are the deterministic gate, but they run
// before Electron exists. These cover what happens once it does.
describe("Electron E2E renderer readiness", () => {
  const roots: string[] = [];

  function makeHomeRoot(options?: { bootstrap?: boolean }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-ready-"));
    roots.push(root);
    if (options?.bootstrap) {
      // Matches `resolveBootstrapProfileDir` — a sibling of `profiles/`.
      fs.mkdirSync(path.join(root, ".pwragent", ".bootstrap", "state"), {
        recursive: true,
      });
    }
    return root;
  }

  /** Minimal stand-ins; `waitForRendererReady` only touches these. */
  function makeWindow(options?: {
    overlayAttaches?: boolean;
    overlayCount?: number;
  }): { window: Parameters<typeof waitForRendererReady>[0]["window"] } {
    const pending = new Promise<void>(() => undefined);
    const window = {
      waitForLoadState: async () => undefined,
      locator: () => ({
        count: async () => options?.overlayCount ?? 0,
        waitFor: async () =>
          options?.overlayAttaches ? undefined : await pending,
      }),
    };
    return { window: window as never };
  }

  function args(overrides: {
    env: Record<string, string>;
    window: Parameters<typeof waitForRendererReady>[0]["window"];
    suppressOnboarding?: boolean;
  }): Parameters<typeof waitForRendererReady>[0] {
    return {
      electronApp: {} as never,
      env: overrides.env,
      requiresReplayDriver: false,
      seedConfigPath: path.join(overrides.env.HOME, "config.toml"),
      suppressOnboarding: overrides.suppressOnboarding ?? true,
      window: overrides.window,
    };
  }

  afterEach(() => {
    while (roots.length > 0) {
      fs.rmSync(roots.pop() as string, { recursive: true, force: true });
    }
  });

  // `initializeAppState("bootstrap")` creates `.bootstrap/` during
  // `app.whenReady()`, before any BrowserWindow exists — which is what
  // makes this check race-free where watching the DOM is not.
  it("names the wizard when the app booted into bootstrap mode", async () => {
    const env = { HOME: makeHomeRoot({ bootstrap: true }) };

    await expect(
      waitForRendererReady(args({ env, ...makeWindow() })),
    ).rejects.toThrow(/onboarding wizard is showing[\s\S]*bootstrap mode/);
  });

  it("passes when no bootstrap profile exists and no overlay is present", async () => {
    const env = { HOME: makeHomeRoot() };

    await expect(
      waitForRendererReady(args({ env, ...makeWindow() })),
    ).resolves.toBeUndefined();
  });

  it("names the wizard when the overlay wins the race against readiness", async () => {
    const env = { HOME: makeHomeRoot() };
    const { window } = makeWindow({ overlayAttaches: true });
    // Readiness never settles, so only the watcher can resolve this.
    const stalled = {
      ...(window as unknown as Record<string, unknown>),
      waitForLoadState: () => new Promise<void>(() => undefined),
    };

    await expect(
      waitForRendererReady(args({ env, window: stalled as never })),
    ).rejects.toThrow(/onboarding wizard is showing/);
  });

  it("names the wizard when the overlay is already up once readiness settles", async () => {
    const env = { HOME: makeHomeRoot() };

    await expect(
      waitForRendererReady(args({ env, ...makeWindow({ overlayCount: 1 }) })),
    ).rejects.toThrow(/onboarding wizard is showing/);
  });

  // Wizard specs want the wizard. None of the above may fire for them.
  it("skips every onboarding check when suppressOnboarding is false", async () => {
    const env = { HOME: makeHomeRoot({ bootstrap: true }) };

    await expect(
      waitForRendererReady(
        args({
          env,
          suppressOnboarding: false,
          ...makeWindow({ overlayAttaches: true, overlayCount: 1 }),
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

// `close()` warns past its budget but must not turn a real cleanup
// failure into a warning nobody reads.
describe("Electron E2E teardown budget", () => {
  it("reports a still-pending teardown as timed out", async () => {
    await expect(
      raceTeardownTimeout(new Promise<void>(() => undefined), 5),
    ).resolves.toBe(true);
  });

  it("reports a teardown that finished in time as not timed out", async () => {
    await expect(raceTeardownTimeout(Promise.resolve(), 5_000)).resolves.toBe(
      false,
    );
  });

  it("propagates a teardown failure rather than reporting a timeout", async () => {
    await expect(
      raceTeardownTimeout(Promise.reject(new Error("ENOTEMPTY")), 5_000),
    ).rejects.toThrow("ENOTEMPTY");
  });
});
