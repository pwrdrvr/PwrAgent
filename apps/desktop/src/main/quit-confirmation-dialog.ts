import { BrowserWindow, nativeTheme } from "electron";
import { readBootstrapAppearance } from "./settings/appearance-bootstrap";

export type QuitConfirmationDialogResult =
  | "manual-confirm"
  | "manual-cancel"
  | "countdown-expired";

export type QuitConfirmationDialogOptions = {
  countdownSeconds: number;
  inProgressThreadCount: number;
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
  shadow: string;
};

const QUIT_DIALOG_PALETTES: Record<"dark" | "light", QuitDialogPalette> = {
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
    shadow: "0 18px 48px rgba(0, 0, 0, 0.42)",
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
    shadow: "0 18px 48px rgba(0, 0, 0, 0.18)",
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
  const window = new BrowserWindow({
    width: 460,
    height: 320,
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

    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(navigationPrefix)) {
        return;
      }
      event.preventDefault();
      const result = url.slice(navigationPrefix.length);
      if (
        result === "manual-confirm" ||
        result === "manual-cancel" ||
        result === "countdown-expired"
      ) {
        finish(result);
      }
    });
    window.once("closed", () => finish("manual-cancel"));
    hardCeiling = setTimeout(
      () => finish("countdown-expired"),
      options.countdownSeconds * 1000,
    );

    void window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        buildQuitConfirmationHtml({
          countdownSeconds: options.countdownSeconds,
          inProgressThreadCount: options.inProgressThreadCount,
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

function buildQuitConfirmationHtml(options: {
  countdownSeconds: number;
  inProgressThreadCount: number;
  navigationPrefix: string;
  colorScheme: "dark" | "light";
  palette: QuitDialogPalette;
}): string {
  const countText =
    options.inProgressThreadCount === 1
      ? "1 thread has an agent turn in progress."
      : `${options.inProgressThreadCount} threads have agent turns in progress.`;
  const p = options.palette;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
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
        flex: 1 1 auto;
        padding: 18px 24px 22px;
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
        margin: 18px 0 0;
        color: var(--text-muted);
        font-weight: 600;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 24px;
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
      <p>If you quit now, those turns will be interrupted. You'll need to find each thread when you restart and tell them to continue.</p>
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
      function send(result) {
        window.location.href = navigationPrefix + result;
      }
      function render() {
        countdown.textContent = "Auto-quitting in " + remaining + " second" + (remaining === 1 ? "" : "s") + "...";
      }
      render();
      const timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(timer);
          countdown.textContent = "Auto-quitting now...";
          send("countdown-expired");
          return;
        }
        render();
      }, 1000);
      document.getElementById("stay").addEventListener("click", () => send("manual-cancel"));
      document.getElementById("close").addEventListener("click", () => send("manual-cancel"));
      document.getElementById("quit").addEventListener("click", () => send("manual-confirm"));
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") send("manual-cancel");
        if (event.key === "Enter") send("manual-confirm");
      });
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
