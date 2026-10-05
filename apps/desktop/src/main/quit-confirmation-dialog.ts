import { app, BrowserWindow, nativeTheme, screen } from "electron";
import { parseThreadIdentityKey } from "@pwragent/shared";
import type {
  DesktopAppearanceTheme,
  DesktopColorTheme,
} from "@pwragent/shared";
import type {
  QuitBlockerItem,
  QuitBlockerQueueSnapshot,
} from "../shared/quit-blockers";
import { revealIntegratedTerminal } from "./ipc/integrated-terminal";
import { getMainLogger } from "./log";
import { primaryMainWindowWebContents } from "./primary-main-window";
import { readBootstrapAppearance } from "./settings/appearance-bootstrap";
import { requestShowQuitBlockers } from "./window-show-quit-blockers";
import { requestShowThread } from "./window-show-thread";

const quitDialogLog = getMainLogger("pwragent:quit-dialog");

export type QuitConfirmationDialogResult =
  | "manual-confirm"
  | "manual-cancel"
  | "countdown-expired"
  | "work-completed";

/** One row in the dialog's "still running" list. */
export type { QuitBlockerItem } from "../shared/quit-blockers";

export type QuitConfirmationDialogOptions = {
  federationPeerCount?: number;
  onCountdownChanged?: (deadlineAt: number | null) => void;
  countdownSeconds: number;
  inProgressThreadCount: number;
  automationRunCount?: number;
  terminalSessionCount: number;
  actionRunCount?: number;
  items?: QuitBlockerItem[];
  refresh?: () => Promise<QuitConfirmationDialogSnapshot>;
};

export type QuitConfirmationDialogSnapshot = QuitBlockerQueueSnapshot;

/**
 * Quit-dialog theme palette. The dialog is a standalone `data:` HTML window
 * with no access to app.css, so we inject the active theme's token VALUES
 * directly. Keep in sync with the matching tokens in app.css (`:root` and
 * `:root[data-theme="light"]`). Derived tokens (accent-border, …) are computed
 * with `color-mix()` in the dialog CSS, exactly like app.css.
 */
type QuitDialogPalette = {
  bg: string;
  sidebar: string;
  surface: string;
  rowActive: string;
  panelHover: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentBright: string;
  buttonText: string;
};

export const QUIT_DIALOG_PALETTES: Record<"dark" | "light", QuitDialogPalette> = {
  dark: {
    bg: "#000000",
    sidebar: "#050505",
    surface: "#101010",
    rowActive: "#120800",
    panelHover: "#14110d",
    border: "rgba(247, 243, 235, 0.1)",
    textPrimary: "#f7f3eb",
    textSecondary: "#b8b0a5",
    textMuted: "#8c857a",
    accent: "#ff8a1f",
    accentBright: "#ffb35c",
    buttonText: "#120800",
  },
  light: {
    bg: "#ffffff",
    sidebar: "#f7f4ef",
    surface: "#ffffff",
    rowActive: "#fff5e9",
    panelHover: "#f4f0e8",
    border: "rgba(0, 0, 0, 0.08)",
    textPrimary: "#1a1612",
    textSecondary: "#524a40",
    // Keep these in lockstep with the `:root[data-theme="light"]` block in
    // src/renderer/src/styles/app.css — this dialog is a separate
    // BrowserWindow, so the renderer's a11y gate (e2e/a11y.spec.ts) cannot
    // reach it and will not catch drift. All three below are used as text
    // colors, and each is at its AA-clearing value: against the darkest
    // background each can land on they measure 4.55:1, 4.57:1, and 4.64:1
    // against the 4.5:1 floor.
    textMuted: "#736c64",
    accent: "#b74c00",
    accentBright: "#994c00",
    buttonText: "#ffffff",
  },
};

/** Every other color theme, from its `:root[data-color-theme="<id>"]` block
 *  in app.css; the border is that block's `--border-subtle` mix resolved to a
 *  literal. A test reads app.css and fails when an entry drifts. Tangerine
 *  is `QUIT_DIALOG_PALETTES` above. */
export const COLOR_THEME_QUIT_DIALOG_PALETTES: Record<
  Exclude<DesktopColorTheme, "tangerine-dark" | "tangerine-light">,
  QuitDialogPalette
> = {
  "catppuccin-mocha": {
    bg: "#1e1e2e",
    sidebar: "#181825",
    surface: "#252536",
    rowActive: "#342d37",
    panelHover: "#28293a",
    border: "rgba(208, 216, 245, 0.1)",
    textPrimary: "#d0d8f5",
    textSecondary: "#b9bed4",
    textMuted: "#a4a9be",
    accent: "#d99d7a",
    accentBright: "#e4a47e",
    buttonText: "#11111b",
  },
  "catppuccin-latte": {
    bg: "#eff1f5",
    sidebar: "#e6e9ef",
    surface: "#f7f8fa",
    rowActive: "#f1e3de",
    panelHover: "#e4e7ed",
    border: "rgba(52, 54, 72, 0.09)",
    textPrimary: "#343648",
    textSecondary: "#454756",
    textMuted: "#545666",
    accent: "#983801",
    accentBright: "#8e3401",
    buttonText: "#eff1f5",
  },
  "solarized-dark": {
    bg: "#002b36",
    sidebar: "#073642",
    surface: "#073642",
    rowActive: "#163731",
    panelHover: "#04313c",
    border: "rgba(188, 197, 197, 0.1)",
    textPrimary: "#bcc5c5",
    textSecondary: "#aeb9ba",
    textMuted: "#a0b1b7",
    accent: "#dba600",
    accentBright: "#e7af00",
    buttonText: "#002b36",
  },
  "solarized-light": {
    bg: "#fdf6e3",
    sidebar: "#eee8d5",
    surface: "#fffcf5",
    rowActive: "#f5e7d2",
    panelHover: "#f6efdc",
    border: "rgba(60, 76, 80, 0.09)",
    textPrimary: "#3c4c50",
    textSecondary: "#45545a",
    textMuted: "#4f5a5a",
    accent: "#9a3911",
    accentBright: "#8e3510",
    buttonText: "#fdf6e3",
  },
  "gray-dark": {
    bg: "#2b2b2e",
    sidebar: "#252528",
    surface: "#323236",
    rowActive: "#403832",
    panelHover: "#37373b",
    border: "rgba(236, 236, 238, 0.1)",
    textPrimary: "#ececee",
    textSecondary: "#c8c8cb",
    textMuted: "#bcbcc0",
    accent: "#ffa95a",
    accentBright: "#ffb876",
    buttonText: "#1c1c1e",
  },
  "gray-light": {
    bg: "#ebebed",
    sidebar: "#e2e2e5",
    surface: "#f6f6f7",
    rowActive: "#e6e0dd",
    panelHover: "#dddde1",
    border: "rgba(29, 29, 32, 0.09)",
    textPrimary: "#1d1d20",
    textSecondary: "#45454b",
    textMuted: "#515157",
    accent: "#8a3900",
    accentBright: "#7f3400",
    buttonText: "#ffffff",
  },
  "blue-dark": {
    bg: "#0f1724",
    sidebar: "#0b121d",
    surface: "#162133",
    rowActive: "#18283e",
    panelHover: "#1a2740",
    border: "rgba(228, 236, 248, 0.1)",
    textPrimary: "#e4ecf8",
    textSecondary: "#b6c4da",
    textMuted: "#95a7c2",
    accent: "#5baaff",
    accentBright: "#6db4ff",
    buttonText: "#06111f",
  },
  "blue-light": {
    bg: "#f3f7fc",
    sidebar: "#e8eff8",
    surface: "#ffffff",
    rowActive: "#e5ecf7",
    panelHover: "#e1e9f4",
    border: "rgba(15, 34, 59, 0.09)",
    textPrimary: "#0f223b",
    textSecondary: "#33486a",
    textMuted: "#475976",
    accent: "#1c56ac",
    accentBright: "#1a4f9f",
    buttonText: "#ffffff",
  },
  "matrix-dark": {
    bg: "#050a06",
    sidebar: "#030704",
    surface: "#0c160e",
    rowActive: "#06250e",
    panelHover: "#112014",
    border: "rgba(200, 245, 208, 0.1)",
    textPrimary: "#c8f5d0",
    textSecondary: "#8fd49c",
    textMuted: "#7db187",
    accent: "#00ff41",
    accentBright: "#6aff90",
    buttonText: "#021a06",
  },
};

function quitDialogPalette(
  colorTheme: DesktopColorTheme,
): QuitDialogPalette {
  if (colorTheme === "tangerine-dark") return QUIT_DIALOG_PALETTES.dark;
  if (colorTheme === "tangerine-light") return QUIT_DIALOG_PALETTES.light;
  return COLOR_THEME_QUIT_DIALOG_PALETTES[colorTheme];
}

/** Resolve the active PwrAgent theme (honoring the in-app setting, not just the
 *  OS). "system" falls back to the OS scheme via nativeTheme. */
function resolveQuitDialogTheme(theme: DesktopAppearanceTheme): "dark" | "light" {
  if (theme === "light") return "light";
  if (theme === "dark") return "dark";
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

/**
 * The dialog currently open, if any.
 *
 * The quit manager collapses concurrent quit requests onto one prompt, so a
 * later request while this dialog is open resolves to the same pending promise.
 * That is only acceptable if the later request can still *reach* the dialog:
 * it is a small frameless window that a user can lose behind the main window or
 * on another Space, and once the countdown has been cancelled nothing else will
 * ever settle the quit. Keeping the handle here is what lets a repeat request
 * raise it instead of doing nothing at all.
 *
 * `ready` tracks `ready-to-show`, because the window is created hidden: showing
 * it before its first paint puts a themed empty rectangle on screen. Until then
 * the prompt is still "open" — its own `ready-to-show` handler shows it — so a
 * raise reports success without touching the window.
 */
type ActiveQuitDialog = {
  window: BrowserWindow;
  parent: BrowserWindow | undefined;
  ready: boolean;
};

let activeDialog: ActiveQuitDialog | undefined;

/**
 * Bring the open quit prompt back in front of the user. Returns false when
 * there is no prompt to raise.
 */
export function focusActiveQuitConfirmationDialog(): boolean {
  const active = activeDialog;
  if (!active || active.window.isDestroyed()) {
    return false;
  }
  if (!active.ready) {
    return true;
  }
  raiseQuitDialog(active);
  return true;
}

/**
 * The window the prompt attaches to: the one the user is in, else the main
 * window. Not just the focused window: a quit from the Dock, from Ctrl+C in the
 * terminal running the app, or from anywhere while another app is active finds
 * no focused PwrAgent window, and an unparented prompt opens wherever the OS
 * centres new windows — on a multi-monitor desk, often a screen nobody is
 * looking at.
 */
function resolveQuitDialogParent(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) {
    return focused;
  }
  const mainContents = primaryMainWindowWebContents();
  const main = mainContents ? BrowserWindow.fromWebContents(mainContents) : null;
  return main && !main.isDestroyed() ? main : undefined;
}

/**
 * Centre the prompt over its parent, kept on the parent's display; with no
 * parent, on the display under the pointer. macOS draws a modal child as a
 * sheet and ignores this, but Windows and Linux centre an unpositioned window
 * on the primary display, parent or not.
 */
function resolveQuitDialogPosition(
  parent: BrowserWindow | undefined,
  width: number,
  height: number,
): { x: number; y: number } {
  // A minimized window on Windows reports off-screen sentinel bounds
  // (-32000, -32000); anchor on where it will be once raiseQuitDialog restores it.
  const anchor = parent?.isMinimized()
    ? parent.getNormalBounds()
    : parent?.getBounds();
  const area = anchor
    ? screen.getDisplayMatching(anchor).workArea
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const target = anchor ?? area;
  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(value, max));
  return {
    x: clamp(
      target.x + Math.round((target.width - width) / 2),
      area.x,
      area.x + area.width - width,
    ),
    y: clamp(
      target.y + Math.round((target.height - height) / 2),
      area.y,
      area.y + area.height - height,
    ),
  };
}

/**
 * Bring the prompt, and the window it is attached to, in front of the user.
 * A sheet on a minimized or buried window is as lost as a dialog on the wrong
 * monitor. On macOS the app is activated outright: every path here is a quit
 * the user (or the OS, for a logout) asked for, and it is waiting on an answer.
 * Off macOS `app.focus()` focuses the first window instead, which could pull an
 * unrelated window over this one, so the window calls alone do it there.
 */
function raiseQuitDialog(active: ActiveQuitDialog): void {
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  const { parent, window } = active;
  if (parent && !parent.isDestroyed()) {
    if (parent.isMinimized()) {
      parent.restore();
    }
    parent.show();
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

export async function showQuitConfirmationDialog(
  options: QuitConfirmationDialogOptions,
): Promise<QuitConfirmationDialogResult> {
  const token = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const navigationPrefix = `pwragent-quit-confirmation://${token}/`;
  const parent = resolveQuitDialogParent();
  const appearance = readBootstrapAppearance();
  const colorScheme = resolveQuitDialogTheme(appearance.theme);
  const palette = quitDialogPalette(
    colorScheme === "light" ? appearance.lightTheme : appearance.darkTheme,
  );
  const items = options.items ?? [];
  const countdownSeconds = resolveQuitCountdownSeconds(
    options.countdownSeconds,
    items.length,
  );
  const width = 460;
  // The list is scrollable, but a dialog that always reserves room for ten
  // rows would look absurd when nothing is running. Grow with the content up
  // to a ceiling, then let the list scroll inside it.
  const height =
    quitDialogHeight(items.length) + (options.federationPeerCount ? 72 : 0);
  const window = new BrowserWindow({
    width,
    height,
    ...resolveQuitDialogPosition(parent, width, height),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    modal: Boolean(parent),
    parent,
    title: "Quit PwrAgent?",
    // Frameless: the native title bar (a white system band on Windows) clashed
    // with the themed card, and a fixed-size modal has no use for min/max/close
    // caption buttons (WCO would render them grayed-out). Render the app's own
    // chrome instead — a branded title strip (PwrAgent wordmark + close) over a
    // themed body; the strip is the drag handle, and Esc / the close button /
    // "Stay Open" all dismiss. Removing the frame also drops the native menu
    // bar that otherwise rendered inside the window on Windows (which had stolen
    // ~20px and forced a vertical scrollbar).
    frame: false,
    // Pre-tint to the themed surface so we don't flash a white window before
    // the data: HTML paints.
    backgroundColor: palette.bg,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const active: ActiveQuitDialog = { window, parent, ready: false };
  activeDialog = active;

  /** Drop the shared handle and the window, whichever way this call ends. */
  const releaseDialog = (): void => {
    if (activeDialog === active) {
      activeDialog = undefined;
    }
    if (!window.isDestroyed()) {
      window.close();
    }
  };

  return await new Promise<QuitConfirmationDialogResult>((resolve) => {
    let settled = false;
    let hardCeiling: NodeJS.Timeout | undefined;
    let refreshTimer: NodeJS.Timeout | undefined;
    let completionTimer: NodeJS.Timeout | undefined;
    let refreshInFlight = false;
    let waitForWork = false;
    let lastTotalCount =
      options.inProgressThreadCount
      + (options.automationRunCount ?? 0)
      + options.terminalSessionCount
      + (options.actionRunCount ?? 0);
    let lastRefreshSignature = JSON.stringify({
      inProgressThreadCount: options.inProgressThreadCount,
      automationRunCount: options.automationRunCount ?? 0,
      terminalSessionCount: options.terminalSessionCount,
      actionRunCount: options.actionRunCount ?? 0,
      items,
    });
    let latestSnapshot: QuitConfirmationDialogSnapshot = {
      inProgressThreadCount: options.inProgressThreadCount,
      automationRunCount: options.automationRunCount ?? 0,
      terminalSessionCount: options.terminalSessionCount,
      actionRunCount: options.actionRunCount ?? 0,
      items,
    };

    const finish = (result: QuitConfirmationDialogResult): void => {
      if (settled) return;
      settled = true;
      if (hardCeiling) clearTimeout(hardCeiling);
      if (refreshTimer) clearInterval(refreshTimer);
      if (completionTimer) clearTimeout(completionTimer);
      releaseDialog();
      resolve(result);
    };

    const cancelCompletion = (): void => {
      if (!completionTimer) return;
      clearTimeout(completionTimer);
      completionTimer = undefined;
    };

    const scheduleCompletion = (): void => {
      if (!waitForWork || lastTotalCount !== 0 || completionTimer || settled) {
        return;
      }
      completionTimer = setTimeout(() => {
        completionTimer = undefined;
        if (waitForWork && lastTotalCount === 0) {
          finish("work-completed");
        }
      }, COMPLETION_REPORT_MS);
    };

    const refreshDialog = async (): Promise<void> => {
      if (!options.refresh || settled || refreshInFlight) return;
      refreshInFlight = true;
      try {
        const snapshot = await options.refresh();
        latestSnapshot = snapshot;
        const signature = JSON.stringify(snapshot);
        const payload = buildQuitDialogUpdatePayload(snapshot, navigationPrefix);
        if (options.federationPeerCount && payload.totalCount === 0) {
          payload.countText = "No local work is running.";
          payload.impactText = "Work on other machines may continue after this instance disconnects.";
        }
        lastTotalCount = payload.totalCount;
        if (lastTotalCount === 0) {
          scheduleCompletion();
        } else {
          cancelCompletion();
        }
        if (signature === lastRefreshSignature) return;
        lastRefreshSignature = signature;
        if (!window.isDestroyed()) {
          void window.webContents.executeJavaScript(
            `window.__pwragentUpdateQuitSnapshot?.(${serializeForJavaScript(payload)})`,
            true,
          ).catch(() => undefined);
        }
        if (payload.totalCount === 0) {
          if (hardCeiling) {
            clearTimeout(hardCeiling);
            hardCeiling = undefined;
          }
        }
      } catch (error) {
        quitDialogLog.warn("quit confirmation refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        refreshInFlight = false;
      }
    };

    // This page interpolates model-generated thread titles and user-configured
    // command strings, so it must not be able to reach the network at all: deny
    // every navigation that is not our own fake-scheme signal, and deny window
    // opens outright. Escaping is the first line of defence; this is the second.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(navigationPrefix)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const action = url.slice(navigationPrefix.length);

      // Any interaction with the dialog cancels the auto-quit — including the
      // main-process hard ceiling, which would otherwise quit out from under a
      // user who is mid-scroll.
      if (action === "countdown-cancel") {
        options.onCountdownChanged?.(null);
        if (hardCeiling) {
          clearTimeout(hardCeiling);
          hardCeiling = undefined;
        }
        return;
      }

      if (action === "wait-for-work") {
        options.onCountdownChanged?.(null);
        waitForWork = true;
        if (hardCeiling) {
          clearTimeout(hardCeiling);
          hardCeiling = undefined;
        }
        scheduleCompletion();
        return;
      }

      // Clicking a row means "don't quit, take me there".
      const target = parseQuitItemAction(action);
      if (target) {
        const parsed = parseThreadIdentityKey(target.threadKey);
        if (parsed) {
          // The reveal knows which window hosts the shell. Reuse that: the
          // dialog itself holds focus here, so an unrouted request falls
          // through to whichever window subscribed first — which for a
          // peer's thread is a window that never mounted it.
          const revealed =
            target.kind === "terminal" && target.sessionId
              ? revealIntegratedTerminal(target.sessionId, {
                  ...(target.instanceId
                    ? { instanceId: target.instanceId }
                    : {}),
                })
              : undefined;
          const viewer = requestShowThread(
            {
              ...parsed,
              ...(target.instanceId
                ? {
                    federationTarget: {
                      scope: "remote" as const,
                      instanceId: target.instanceId,
                    },
                  }
                : {}),
            },
            { preferWebContents: revealed?.owner },
          );
          if (viewer) {
            requestShowQuitBlockers(viewer, latestSnapshot);
          }
        }
        finish("manual-cancel");
        return;
      }

      if (
        action === "manual-confirm" ||
        action === "manual-cancel" ||
        action === "countdown-expired"
      ) {
        finish(action);
      }
    });
    window.once("closed", () => finish("manual-cancel"));
    options.onCountdownChanged?.(Date.now() + countdownSeconds * 1000);
    hardCeiling = setTimeout(
      () => finish("countdown-expired"),
      countdownSeconds * 1000 + HARD_CEILING_GRACE_MS,
    );

    const dialogUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
      buildQuitConfirmationHtml({
        countdownSeconds,
        federationPeerCount: options.federationPeerCount,
        inProgressThreadCount: options.inProgressThreadCount,
        automationRunCount: options.automationRunCount ?? 0,
        terminalSessionCount: options.terminalSessionCount,
        actionRunCount: options.actionRunCount ?? 0,
        items,
        navigationPrefix,
        colorScheme,
        palette,
      }),
    )}`;
    // A rejected load leaves a window that never emits `ready-to-show` and never
    // renders a control, so there is no consent to collect and nothing for the
    // user to answer — showing the empty window would only park an unusable box
    // on screen until the hard ceiling fires. Settle the request the same way
    // that ceiling would, immediately, and record why. A rejection that arrives
    // *after* the page painted is noise (a superseded navigation, say): the
    // prompt is up and the user owns the decision, so only log it.
    void window.loadURL(dialogUrl).catch((error: unknown) => {
      quitDialogLog.warn("quit confirmation dialog failed to load", {
        error: error instanceof Error ? error.message : String(error),
        painted: active.ready,
      });
      if (!active.ready) {
        finish("countdown-expired");
      }
    });
    window.once("ready-to-show", () => {
      active.ready = true;
      raiseQuitDialog(active);
      if (options.refresh) {
        void refreshDialog();
        refreshTimer = setInterval(
          () => void refreshDialog(),
          QUIT_REFRESH_INTERVAL_MS,
        );
        refreshTimer.unref?.();
      }
    });
  }).catch((error: unknown) => {
    // An executor that throws would otherwise strand the shared handle on a
    // window nobody closes, and a later raise would surface an orphan dialog.
    releaseDialog();
    throw error;
  });
}

const DIALOG_BASE_HEIGHT = 340;
const DIALOG_ROW_HEIGHT = 46;
const DIALOG_MAX_HEIGHT = 620;

/** Per listed item, on top of the base countdown. Ten terminals is not a
 *  ten-second read. */
const COUNTDOWN_SECONDS_PER_ITEM = 3;
const COUNTDOWN_MAX_SECONDS = 60;

/**
 * The countdown exists so an unattended machine can finish shutting down, not
 * to rush a human. Scale it with how much there is to read; any interaction
 * cancels it outright.
 */
export function resolveQuitCountdownSeconds(
  baseSeconds: number,
  itemCount: number,
): number {
  if (itemCount <= 0) return baseSeconds;
  return Math.min(
    COUNTDOWN_MAX_SECONDS,
    baseSeconds + itemCount * COUNTDOWN_SECONDS_PER_ITEM,
  );
}

/** The main-process ceiling must never beat the in-dialog cancel to the punch:
 *  a `countdown-cancel` fired in the final tick has to survive the round trip. */
const HARD_CEILING_GRACE_MS = 1_500;
const QUIT_REFRESH_INTERVAL_MS = 500;
const COMPLETION_REPORT_MS = 1_250;

function quitDialogHeight(itemCount: number): number {
  if (itemCount === 0) return DIALOG_BASE_HEIGHT;
  // + section headers (at most three) and the list's own padding.
  const listHeight = itemCount * DIALOG_ROW_HEIGHT + 56;
  return Math.min(DIALOG_MAX_HEIGHT, DIALOG_BASE_HEIGHT + listHeight);
}

const QUIT_ITEM_GROUPS: ReadonlyArray<{
  kind: QuitBlockerItem["kind"];
  heading: string;
}> = [
  { kind: "turn", heading: "Agent turns in progress" },
  { kind: "automation", heading: "Automations in progress" },
  { kind: "terminal", heading: "Integrated terminals" },
  { kind: "action", heading: "Environment actions" },
];

/**
 * Encode a row's target as URL segments.
 *
 * The thread key travels whole rather than as `backend/threadId`: an ACP
 * backend kind ("acp:grok") contains a colon, and thread ids are opaque, so
 * splitting on delimiters here corrupts the key that the terminal registry and
 * the renderer both index by.
 *
 * The owning instance rides along for remote rows. A thread key does not
 * identify a thread across instances — the same reason titles are resolved per
 * instance — so without it a peer's row and a same-keyed local row encode to
 * the same action and the click cannot tell them apart.
 */
export function formatQuitItemAction(item: QuitBlockerItem): string {
  // Positional, so the instance slot is written EMPTY rather than omitted
  // when a terminal id follows it — otherwise a local terminal's id lands in
  // the instance slot and the click looks for that shell on a peer.
  const segments = [
    "show-thread",
    encodeURIComponent(item.threadKey),
    encodeURIComponent(item.kind),
    item.target ? encodeURIComponent(item.target.instanceId) : "",
    item.sessionId ? encodeURIComponent(item.sessionId) : "",
  ];
  // Trailing empties carry nothing. Dropping them keeps every row that has no
  // terminal id encoding exactly as it did before terminals grew one.
  while (segments.length > 3 && segments[segments.length - 1] === "") {
    segments.pop();
  }
  return segments.join("/");
}

export function parseQuitItemAction(action: string):
  | {
      threadKey: string;
      kind: string;
      instanceId?: string;
      sessionId?: string;
    }
  | undefined {
  if (!action.startsWith("show-thread/")) {
    return undefined;
  }
  const [, encodedThreadKey, encodedKind, encodedInstanceId, encodedSessionId] =
    action.split("/");
  if (!encodedThreadKey) {
    return undefined;
  }
  try {
    const instanceId = encodedInstanceId
      ? decodeURIComponent(encodedInstanceId)
      : undefined;
    const sessionId = encodedSessionId
      ? decodeURIComponent(encodedSessionId)
      : undefined;
    return {
      threadKey: decodeURIComponent(encodedThreadKey),
      kind: decodeURIComponent(encodedKind ?? ""),
      ...(instanceId ? { instanceId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  } catch {
    return undefined;
  }
}

function buildQuitItemListHtml(options: {
  items: QuitBlockerItem[];
  navigationPrefix: string;
}): string {
  if (options.items.length === 0) {
    return "";
  }
  const sections = QUIT_ITEM_GROUPS.map((group) => {
    const groupItems = options.items.filter((item) => item.kind === group.kind);
    if (groupItems.length === 0) return "";
    const rows = groupItems
      .map((item) => {
        const href = `${options.navigationPrefix}${formatQuitItemAction(item)}`;
        const label = item.title?.trim() || item.threadId;
        const detail = item.detail?.trim();
        return `<a class="row" href="${escapeHtml(href)}">
          <span class="row__heading">
            <span class="row__label">${escapeHtml(label)}</span>
            ${item.isSubAgent ? '<span class="row__chip">Sub-agent</span>' : ""}
          </span>
          ${detail ? `<span class="row__detail">${escapeHtml(detail)}</span>` : ""}
        </a>`;
      })
      .join("");
    return `<p class="group">${escapeHtml(group.heading)}</p>${rows}`;
  }).join("");

  return `<div class="list" id="list">${sections}</div>`;
}

export function buildQuitConfirmationHtml(options: {
  federationPeerCount?: number;
  countdownSeconds: number;
  inProgressThreadCount: number;
  automationRunCount?: number;
  terminalSessionCount: number;
  actionRunCount: number;
  items: QuitBlockerItem[];
  navigationPrefix: string;
  colorScheme: "dark" | "light";
  palette: QuitDialogPalette;
}): string {
  const peerOnly = Boolean(options.federationPeerCount)
    && options.inProgressThreadCount === 0
    && (options.automationRunCount ?? 0) === 0
    && options.terminalSessionCount === 0
    && options.actionRunCount === 0;
  const countText = peerOnly ? "No local work is running." : describeQuitBlockers({
    inProgressThreadCount: options.inProgressThreadCount,
    automationRunCount: options.automationRunCount,
    terminalSessionCount: options.terminalSessionCount,
    actionRunCount: options.actionRunCount,
  });
  const interruptionText = peerOnly ? "Work on other machines may continue after this instance disconnects." : describeQuitImpact({
    inProgressThreadCount: options.inProgressThreadCount,
    automationRunCount: options.automationRunCount,
    terminalSessionCount: options.terminalSessionCount,
    actionRunCount: options.actionRunCount,
    hasItems: options.items.length > 0,
  });
  const listHtml = buildQuitItemListHtml({
    items: options.items,
    navigationPrefix: options.navigationPrefix,
  });
  const p = options.palette;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <!-- The page carries model-generated thread titles and user command strings.
         It needs nothing from the network, so forbid the network: no origin can
         be reached even if an escaping bug ever lets markup through. -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"
    />
    <style>
      :root {
        color-scheme: ${options.colorScheme};
        --bg: ${p.bg};
        --sidebar: ${p.sidebar};
        --surface: ${p.surface};
        --row-active: ${p.rowActive};
        --panel-hover: ${p.panelHover};
        --border: ${p.border};
        --text-primary: ${p.textPrimary};
        --text-secondary: ${p.textSecondary};
        --text-muted: ${p.textMuted};
        --accent: ${p.accent};
        --accent-bright: ${p.accentBright};
        --button-text: ${p.buttonText};
        /* Derived exactly like app.css's --accent-border. */
        --accent-border: color-mix(in srgb, var(--accent) 42%, transparent);
        font-family: "Geist", "IBM Plex Sans", "SF Pro Text", "Inter", system-ui, sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        background: var(--bg);
        color: var(--text-secondary);
        font-size: 14px;
        /* Frameless: a hairline edges the card. */
        border: 1px solid var(--border);
        -webkit-font-smoothing: antialiased;
        -webkit-user-select: none;
        user-select: none;
      }
      /* Branded title strip — the same chrome as the app windows: wordmark on
         the left, close on the right, draggable (interactive children opt out
         with -webkit-app-region: no-drag). Mirrors --bg-sidebar + the brand
         tokens (--text-primary / --accent). */
      .titlebar {
        display: flex;
        align-items: center;
        flex: 0 0 auto;
        height: 40px;
        padding: 0 8px 0 16px;
        background: var(--sidebar);
        border-bottom: 1px solid var(--border);
        -webkit-app-region: drag;
      }
      .brand {
        margin: 0;
        color: var(--text-primary);
        font-size: 14px;
        font-weight: 700;
        line-height: 1;
        letter-spacing: -0.01em;
      }
      .brand-accent {
        color: var(--accent);
      }
      .titlebar__spacer {
        flex: 1 1 auto;
      }
      .content {
        display: flex;
        flex-direction: column;
        /* min-height:0 is what actually lets .list scroll instead of blowing
           the flex column past the window. */
        min-height: 0;
        flex: 1 1 auto;
        padding: 18px 24px 22px;
      }
      /* The list of still-running work. Scrolls inside the dialog; the row
         links cancel the quit and navigate. */
      .list {
        min-height: 0;
        flex: 1 1 auto;
        overflow-y: auto;
        margin: 4px -6px 0;
        padding: 0 6px;
      }
      .group {
        margin: 10px 0 6px;
        color: var(--text-muted);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .group:first-child {
        margin-top: 0;
      }
      .row {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 6px 8px;
        border: 1px solid transparent;
        border-radius: 6px;
        color: var(--text-primary);
        text-decoration: none;
        cursor: pointer;
        -webkit-app-region: no-drag;
      }
      .row:hover {
        border-color: var(--accent-border);
        background: var(--panel-hover);
      }
      .row--finished {
        opacity: 0.72;
      }
      .row:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }
      .row__label {
        min-width: 0;
        font-size: 13px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .row__heading {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .row__chip {
        flex: 0 0 auto;
        padding: 1px 5px;
        border: 1px solid var(--accent-border);
        border-radius: 8px;
        background: var(--row-active);
        color: var(--accent-bright);
        font-size: 10px;
        font-weight: 600;
        line-height: 1.35;
      }
      .row__detail {
        color: var(--text-muted);
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      h1 {
        margin: 0 0 14px;
        color: var(--text-primary);
        font-size: 18px;
        font-weight: 650;
        line-height: 1.25;
        letter-spacing: -0.01em;
      }
      p {
        margin: 0 0 12px;
        line-height: 1.45;
      }
      .countdown {
        margin: 14px 0 0;
        flex: 0 0 auto;
        color: var(--text-muted);
        font-weight: 600;
      }
      .actions {
        display: flex;
        flex: 0 0 auto;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 16px;
      }
      /* Mirrors the .button / .button--primary / .button--secondary primitives
         in app.css. */
      button {
        min-width: 96px;
        min-height: 34px;
        padding: 0 14px;
        border: 1px solid transparent;
        border-radius: 6px;
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        -webkit-app-region: no-drag;
        transition:
          background-color 120ms ease,
          border-color 120ms ease,
          color 120ms ease;
      }
      button:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .secondary {
        border-color: var(--border);
        background: var(--surface);
        color: var(--text-primary);
      }
      .secondary:hover {
        border-color: var(--accent-border);
        background: var(--panel-hover);
      }
      .primary {
        border-color: var(--accent-border);
        background: var(--row-active);
        color: var(--accent-bright);
        font-weight: 600;
      }
      .primary:hover {
        background: var(--accent);
        color: var(--button-text);
      }
      /* Close (top-right of the strip) → maps to "Stay Open". */
      .close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        min-width: 0;
        min-height: 0;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--text-muted);
        font-size: 15px;
        line-height: 1;
      }
      .close:hover {
        background: var(--panel-hover);
        color: var(--text-primary);
      }
    </style>
  </head>
  <body>
    <header class="titlebar">
      <p class="brand">Pwr<span class="brand-accent">Agent</span></p>
      <div class="titlebar__spacer"></div>
      <button class="close" id="close" type="button" aria-label="Stay open" title="Stay open (Esc)">&#10005;</button>
    </header>
    <main class="content">
      <h1>Quit PwrAgent?</h1>
      ${options.federationPeerCount ? `<p>${options.federationPeerCount} connected peer${options.federationPeerCount === 1 ? "" : "s"} will lose access through this instance. Peers that support shutdown notices have been notified.</p>` : ""}
      <p id="blocker-count">${escapeHtml(countText)}</p>
      <p id="blocker-impact">${escapeHtml(interruptionText)}</p>
      ${listHtml}
      <p class="countdown" id="countdown"></p>
      <div class="actions">
        <button id="stay" class="secondary" type="button">Stay Open</button>
        ${peerOnly ? "" : '<button id="wait" class="secondary" type="button">Wait for Work</button>'}
        <button id="quit" class="primary" type="button" autofocus>Quit Now</button>
      </div>
    </main>
    <script>
      const navigationPrefix = ${JSON.stringify(options.navigationPrefix)};
      let remaining = ${JSON.stringify(options.countdownSeconds)};
      const countdown = document.getElementById("countdown");
      let timer;
      let waitingForWork = false;

      function send(result) {
        window.location.href = navigationPrefix + result;
      }
      function render() {
        countdown.textContent = "Auto-quitting in " + remaining + " second" + (remaining === 1 ? "" : "s") + "...";
      }
      // Quitting out from under someone who is reading the list is the worst
      // possible outcome here, so ANY sign of a human — moving the mouse over
      // the dialog, scrolling, a keystroke, focusing anything — stops the clock
      // for good. The main-process hard ceiling is cleared too, via
      // "countdown-cancel". The countdown still exists so an unattended machine
      // (OS shutdown, update install) can finish quitting.
      function cancelCountdown() {
        if (!timer) return;
        clearInterval(timer);
        timer = undefined;
        countdown.textContent = "Auto-quit cancelled. Choose an option below.";
        send("countdown-cancel");
      }
      window.__pwragentUpdateQuitSnapshot = (snapshot) => {
        document.getElementById("blocker-count").textContent = snapshot.countText;
        document.getElementById("blocker-impact").textContent = snapshot.impactText;
        const currentList = document.getElementById("list");
        if (snapshot.totalCount === 0) {
          if (waitingForWork && timer) {
            clearInterval(timer);
            timer = undefined;
          }
          const finishedAt = new Date().toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
          });
          for (const row of document.querySelectorAll(".row")) {
            row.classList.add("row--finished");
            let detail = row.querySelector(".row__detail");
            if (!detail) {
              detail = document.createElement("span");
              detail.className = "row__detail";
              row.append(detail);
            }
            detail.textContent = "Finished " + finishedAt;
          }
          if (waitingForWork) {
            countdown.textContent = "All running work finished. Quitting now...";
          } else if (!timer) {
            countdown.textContent = "All running work finished. Choose an option below.";
          }
          return;
        }
        if (snapshot.listHtml) {
          if (currentList) {
            currentList.outerHTML = snapshot.listHtml;
          } else {
            countdown.insertAdjacentHTML("beforebegin", snapshot.listHtml);
          }
        } else {
          currentList?.remove();
        }
      };
      render();
      timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(timer);
          timer = undefined;
          countdown.textContent = "Auto-quitting now...";
          send("countdown-expired");
          return;
        }
        render();
      }, 1000);

      // Deliberate interaction only. Two things that look like engagement are
      // not: "focusin" fires immediately because the Quit button is autofocused,
      // and "pointermove" fires when the window simply appears underneath a
      // stationary cursor. Either would cancel the countdown before anyone had
      // read a word, leaving an unattended shutdown (OS restart, update install)
      // waiting forever for a human who isn't there. A click, a scroll, or a
      // keystroke is a person; a cursor sitting still is not.
      for (const eventName of ["pointerdown", "wheel", "keydown"]) {
        document.addEventListener(eventName, cancelCountdown, { passive: true });
      }

      document.getElementById("stay").addEventListener("click", () => send("manual-cancel"));
      document.getElementById("close").addEventListener("click", () => send("manual-cancel"));
      document.getElementById("wait")?.addEventListener("click", () => {
        cancelCountdown();
        waitingForWork = true;
        countdown.textContent = "Waiting for running work to finish...";
        send("wait-for-work");
      });
      document.getElementById("quit").addEventListener("click", () => send("manual-confirm"));
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") send("manual-cancel");
        // Enter still confirms, but not while a row link has focus — there it
        // means "follow this link".
        if (event.key === "Enter" && !document.activeElement?.classList.contains("row")) {
          send("manual-confirm");
        }
      });
    </script>
  </body>
</html>`;
}

function buildQuitDialogUpdatePayload(
  snapshot: QuitConfirmationDialogSnapshot,
  navigationPrefix: string,
): {
  countText: string;
  impactText: string;
  listHtml: string;
  totalCount: number;
} {
  const counts = {
    inProgressThreadCount: snapshot.inProgressThreadCount,
    automationRunCount: snapshot.automationRunCount,
    terminalSessionCount: snapshot.terminalSessionCount,
    actionRunCount: snapshot.actionRunCount,
  };
  const totalCount =
    counts.inProgressThreadCount
    + counts.automationRunCount
    + counts.terminalSessionCount
    + counts.actionRunCount;
  return {
    countText:
      totalCount === 0
        ? "All running work finished."
        : describeQuitBlockers(counts),
    impactText:
      totalCount === 0
        ? "PwrAgent can now quit without interrupting it."
        : describeQuitImpact({
            ...counts,
            hasItems: snapshot.items.length > 0,
          }),
    listHtml: buildQuitItemListHtml({
      items: snapshot.items,
      navigationPrefix,
    }),
    totalCount,
  };
}

function serializeForJavaScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function describeQuitBlockers(options: {
  inProgressThreadCount: number;
  automationRunCount?: number;
  terminalSessionCount: number;
  actionRunCount: number;
}): string {
  const parts: string[] = [];
  if (options.inProgressThreadCount === 1) {
    parts.push("1 thread has an agent turn in progress");
  } else if (options.inProgressThreadCount > 1) {
    parts.push(`${options.inProgressThreadCount} threads have agent turns in progress`);
  }
  if (options.automationRunCount === 1) {
    parts.push("1 automation is running");
  } else if ((options.automationRunCount ?? 0) > 1) {
    parts.push(`${options.automationRunCount} automations are running`);
  }
  if (options.terminalSessionCount === 1) {
    parts.push("1 integrated terminal is running");
  } else if (options.terminalSessionCount > 1) {
    parts.push(`${options.terminalSessionCount} integrated terminals are running`);
  }
  if (options.actionRunCount === 1) {
    parts.push("1 environment action is running");
  } else if (options.actionRunCount > 1) {
    parts.push(`${options.actionRunCount} environment actions are running`);
  }
  if (parts.length === 0) {
    return "PwrAgent is ready to quit.";
  }
  if (parts.length === 1) {
    return `${parts[0]}.`;
  }
  const last = parts[parts.length - 1];
  return `${parts.slice(0, -1).join(", ")}, and ${last}.`;
}

function describeQuitImpact(options: {
  inProgressThreadCount: number;
  automationRunCount?: number;
  terminalSessionCount: number;
  actionRunCount: number;
  hasItems: boolean;
}): string {
  const consequences: string[] = [];
  if (options.inProgressThreadCount > 0) {
    consequences.push("those turns will be interrupted");
  }
  if ((options.automationRunCount ?? 0) > 0) {
    consequences.push("automation runs will be interrupted");
  }
  if (options.terminalSessionCount > 0) {
    consequences.push("terminal processes will be killed");
  }
  if (options.actionRunCount > 0) {
    consequences.push("environment action processes will be stopped");
  }
  if (consequences.length === 0) {
    return "Nothing is running.";
  }
  const joined =
    consequences.length === 1
      ? consequences[0]
      : `${consequences.slice(0, -1).join(", ")} and ${
          consequences[consequences.length - 1]
        }`;
  const followUp = options.hasItems
    ? " Select an item below to go to it instead."
    : "";
  return `If you quit now, ${joined}.${followUp}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
