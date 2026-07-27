import { BrowserWindow, nativeTheme } from "electron";
import { parseThreadIdentityKey } from "@pwragent/shared";
import { revealIntegratedTerminal } from "./ipc/integrated-terminal";
import { readBootstrapAppearance } from "./settings/appearance-bootstrap";
import { requestShowThread } from "./window-show-thread";

export type QuitConfirmationDialogResult =
  | "manual-confirm"
  | "manual-cancel"
  | "countdown-expired";

/**
 * One row in the dialog's "still running" list. Declared here rather than in
 * `quit-manager` because quit-manager imports this module — the reverse would
 * be a dependency cycle.
 */
export type QuitBlockerItem = {
  kind: "turn" | "terminal" | "action";
  backend: string;
  threadId: string;
  threadKey: string;
  /** Resolved just before the dialog opens; falls back to the thread id. */
  title?: string;
  /** Secondary line — the command and pid for an action, for example. */
  detail?: string;
};

export type QuitConfirmationDialogOptions = {
  countdownSeconds: number;
  inProgressThreadCount: number;
  terminalSessionCount: number;
  actionRunCount?: number;
  items?: QuitBlockerItem[];
  parent?: BrowserWindow | null;
};

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
    textMuted: "#807870",
    accent: "#c45200",
    accentBright: "#d96d00",
    buttonText: "#ffffff",
  },
};

/** Resolve the active PwrAgent theme (honoring the in-app setting, not just the
 *  OS). "system" falls back to the OS scheme via nativeTheme. */
function resolveQuitDialogTheme(): "dark" | "light" {
  const { theme } = readBootstrapAppearance();
  if (theme === "light") return "light";
  if (theme === "dark") return "dark";
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

export async function showQuitConfirmationDialog(
  options: QuitConfirmationDialogOptions,
): Promise<QuitConfirmationDialogResult> {
  const token = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const navigationPrefix = `pwragent-quit-confirmation://${token}/`;
  const parent =
    options.parent && !options.parent.isDestroyed() ? options.parent : undefined;
  const colorScheme = resolveQuitDialogTheme();
  const palette = QUIT_DIALOG_PALETTES[colorScheme];
  const items = options.items ?? [];
  const countdownSeconds = resolveQuitCountdownSeconds(
    options.countdownSeconds,
    items.length,
  );
  const window = new BrowserWindow({
    width: 460,
    // The list is scrollable, but a dialog that always reserves room for ten
    // rows would look absurd when nothing is running. Grow with the content up
    // to a ceiling, then let the list scroll inside it.
    height: quitDialogHeight(items.length),
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

  return await new Promise<QuitConfirmationDialogResult>((resolve) => {
    let settled = false;
    let hardCeiling: NodeJS.Timeout | undefined;

    const finish = (result: QuitConfirmationDialogResult): void => {
      if (settled) return;
      settled = true;
      if (hardCeiling) clearTimeout(hardCeiling);
      if (!window.isDestroyed()) {
        window.close();
      }
      resolve(result);
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
        if (hardCeiling) {
          clearTimeout(hardCeiling);
          hardCeiling = undefined;
        }
        return;
      }

      // Clicking a row means "don't quit, take me there".
      const target = parseQuitItemAction(action);
      if (target) {
        const parsed = parseThreadIdentityKey(target.threadKey);
        if (parsed) {
          if (target.kind === "terminal") {
            revealIntegratedTerminal(target.threadKey);
          }
          requestShowThread(parsed);
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
    hardCeiling = setTimeout(
      () => finish("countdown-expired"),
      countdownSeconds * 1000 + HARD_CEILING_GRACE_MS,
    );

    void window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        buildQuitConfirmationHtml({
          countdownSeconds,
          inProgressThreadCount: options.inProgressThreadCount,
          terminalSessionCount: options.terminalSessionCount,
          actionRunCount: options.actionRunCount ?? 0,
          items,
          navigationPrefix,
          colorScheme,
          palette,
        }),
      )}`,
    );
    window.once("ready-to-show", () => {
      window.show();
      window.focus();
    });
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
  { kind: "terminal", heading: "Integrated terminals" },
  { kind: "action", heading: "Environment actions" },
];

/**
 * Encode a row's target as a single URL segment.
 *
 * The thread key travels whole rather than as `backend/threadId`: an ACP
 * backend kind ("acp:grok") contains a colon, and thread ids are opaque, so
 * splitting on delimiters here corrupts the key that the terminal registry and
 * the renderer both index by.
 */
export function formatQuitItemAction(item: QuitBlockerItem): string {
  return `show-thread/${encodeURIComponent(item.threadKey)}/${encodeURIComponent(
    item.kind,
  )}`;
}

export function parseQuitItemAction(
  action: string,
): { threadKey: string; kind: string } | undefined {
  if (!action.startsWith("show-thread/")) {
    return undefined;
  }
  const [, encodedThreadKey, encodedKind] = action.split("/");
  if (!encodedThreadKey) {
    return undefined;
  }
  try {
    return {
      threadKey: decodeURIComponent(encodedThreadKey),
      kind: decodeURIComponent(encodedKind ?? ""),
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
          <span class="row__label">${escapeHtml(label)}</span>
          ${detail ? `<span class="row__detail">${escapeHtml(detail)}</span>` : ""}
        </a>`;
      })
      .join("");
    return `<p class="group">${escapeHtml(group.heading)}</p>${rows}`;
  }).join("");

  return `<div class="list" id="list">${sections}</div>`;
}

export function buildQuitConfirmationHtml(options: {
  countdownSeconds: number;
  inProgressThreadCount: number;
  terminalSessionCount: number;
  actionRunCount: number;
  items: QuitBlockerItem[];
  navigationPrefix: string;
  colorScheme: "dark" | "light";
  palette: QuitDialogPalette;
}): string {
  const countText = describeQuitBlockers({
    inProgressThreadCount: options.inProgressThreadCount,
    terminalSessionCount: options.terminalSessionCount,
    actionRunCount: options.actionRunCount,
  });
  const interruptionText = describeQuitImpact({
    inProgressThreadCount: options.inProgressThreadCount,
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
      .row:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }
      .row__label {
        font-size: 13px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
      <p>${escapeHtml(countText)}</p>
      <p>${escapeHtml(interruptionText)}</p>
      ${listHtml}
      <p class="countdown" id="countdown"></p>
      <div class="actions">
        <button id="stay" class="secondary" type="button">Stay Open</button>
        <button id="quit" class="primary" type="button" autofocus>Quit Now</button>
      </div>
    </main>
    <script>
      const navigationPrefix = ${JSON.stringify(options.navigationPrefix)};
      let remaining = ${JSON.stringify(options.countdownSeconds)};
      const countdown = document.getElementById("countdown");
      let timer;

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

function describeQuitBlockers(options: {
  inProgressThreadCount: number;
  terminalSessionCount: number;
  actionRunCount: number;
}): string {
  const parts: string[] = [];
  if (options.inProgressThreadCount === 1) {
    parts.push("1 thread has an agent turn in progress");
  } else if (options.inProgressThreadCount > 1) {
    parts.push(`${options.inProgressThreadCount} threads have agent turns in progress`);
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
  terminalSessionCount: number;
  actionRunCount: number;
  hasItems: boolean;
}): string {
  const consequences: string[] = [];
  if (options.inProgressThreadCount > 0) {
    consequences.push("those turns will be interrupted");
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
