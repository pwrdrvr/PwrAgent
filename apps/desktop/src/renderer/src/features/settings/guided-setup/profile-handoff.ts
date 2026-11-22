import type { DesktopApi } from "../../../lib/desktop-api";

export type ProfileHandoffApi = Pick<
  DesktopApi,
  | "openPwrAgentProfile"
  | "waitForProfileAlive"
  | "quitApp"
  | "shutdownMessagingRuntime"
>;

export type ProfileHandoffOutcome =
  | { kind: "unavailable" }
  | { kind: "open-failed"; error: unknown }
  /** The profile opened in its own window; this one stays. */
  | { kind: "opened" }
  /** Bootstrap only: the new window never reported ready, so the bootstrap
   *  window stays as the operator's fallback. */
  | { kind: "kept-bootstrap"; reason: "not-alive" | "alive-check-failed" }
  /** Bootstrap only: the new window is up and the bootstrap one quit. */
  | { kind: "handed-off" }
  /** Bootstrap in dev: a second instance can't attach to the Vite server,
   *  so the profile is ready for the next launch and this one quits. */
  | { kind: "dev-quit" };

/** How long the new instance has to write its runtime heartbeat marker. */
export const PROFILE_ALIVE_TIMEOUT_MS = 10_000;
/** Time for the new renderer to paint after its heartbeat appears. */
export const POST_ALIVE_GRACE_MS = 2_000;

/**
 * Open a just-created profile, with the relaunch handoff first-run setup
 * uses.
 *
 * In bootstrap mode the current instance is a throwaway: it releases its
 * messaging adapters (a Telegram long poll or Discord gateway can't be held
 * by two processes), opens the new profile, waits for its heartbeat, and
 * only then quits. If the new instance never reports ready, the bootstrap
 * window stays, so the operator is never left with no window at all.
 *
 * In an active profile, which is where Settings runs, the operator's own
 * window stays open and keeps its messaging adapters. A new profile has
 * its own secrets and no messaging yet, so nothing collides.
 */
export async function openCreatedProfile(params: {
  api: ProfileHandoffApi | undefined;
  profile: string;
  bootMode: "bootstrap" | "active-profile" | undefined;
  isDev: boolean;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string, detail?: unknown) => void;
}): Promise<ProfileHandoffOutcome> {
  const { api, profile } = params;
  const sleep = params.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const warn = params.warn
    ?? ((message: string, detail?: unknown) => console.warn(message, detail));
  if (!api?.openPwrAgentProfile) return { kind: "unavailable" };
  const bootstrap = params.bootMode === "bootstrap";

  if (bootstrap && api.shutdownMessagingRuntime) {
    try {
      await api.shutdownMessagingRuntime();
    } catch (caught) {
      warn(
        "Guided setup: shutdownMessagingRuntime failed before opening the new profile",
        caught,
      );
    }
  }

  if (bootstrap && params.isDev) {
    // A detached second Electron can't reach electron-vite's dev server, so
    // the new window would land on chrome-error://. The profile is already
    // the registry default; the next `pnpm dev` opens it.
    if (api.quitApp) {
      try {
        await api.quitApp();
      } catch (caught) {
        warn("Guided setup: quitApp after creating the profile (dev) failed", caught);
      }
    }
    return { kind: "dev-quit" };
  }

  try {
    await api.openPwrAgentProfile({ profile });
  } catch (caught) {
    warn(`Guided setup: could not open "${profile}"`, caught);
    return { kind: "open-failed", error: caught };
  }
  if (!bootstrap) return { kind: "opened" };

  if (api.waitForProfileAlive) {
    try {
      const result = await api.waitForProfileAlive({
        profile,
        timeoutMs: PROFILE_ALIVE_TIMEOUT_MS,
      });
      if (!result.alive) {
        warn(
          `Guided setup: "${profile}" didn't report alive in time; keeping the bootstrap window open`,
        );
        return { kind: "kept-bootstrap", reason: "not-alive" };
      }
    } catch (caught) {
      warn("Guided setup: waitForProfileAlive failed; keeping the bootstrap window open", caught);
      return { kind: "kept-bootstrap", reason: "alive-check-failed" };
    }
  }

  await sleep(POST_ALIVE_GRACE_MS);
  if (api.quitApp) {
    try {
      await api.quitApp();
    } catch (caught) {
      warn("Guided setup: quitApp after the handoff failed", caught);
    }
  }
  return { kind: "handed-off" };
}
