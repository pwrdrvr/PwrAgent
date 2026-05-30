import { BrowserWindow } from "electron";

export type QuitConfirmationDialogResult =
  | "manual-confirm"
  | "manual-cancel"
  | "countdown-expired";

export type QuitConfirmationDialogOptions = {
  countdownSeconds: number;
  inProgressThreadCount: number;
  parent?: BrowserWindow | null;
};

export async function showQuitConfirmationDialog(
  options: QuitConfirmationDialogOptions,
): Promise<QuitConfirmationDialogResult> {
  const token = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const navigationPrefix = `pwragent-quit-confirmation://${token}/`;
  const parent =
    options.parent && !options.parent.isDestroyed() ? options.parent : undefined;
  const window = new BrowserWindow({
    width: 460,
    height: 312,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    modal: Boolean(parent),
    parent,
    title: "Quit PwrAgent?",
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
}): string {
  const countText =
    options.inProgressThreadCount === 1
      ? "1 thread has an agent turn in progress."
      : `${options.inProgressThreadCount} threads have agent turns in progress.`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        box-sizing: border-box;
        margin: 0;
        padding: 24px;
        background: Canvas;
        color: CanvasText;
      }
      h1 {
        font-size: 20px;
        line-height: 1.25;
        margin: 0 0 18px;
        font-weight: 650;
      }
      p {
        font-size: 14px;
        line-height: 1.45;
        margin: 0 0 14px;
      }
      .countdown {
        font-weight: 650;
        margin-top: 20px;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 26px;
      }
      button {
        border-radius: 6px;
        border: 1px solid ButtonBorder;
        color: ButtonText;
        background: ButtonFace;
        min-width: 96px;
        min-height: 32px;
        padding: 0 14px;
        font: inherit;
      }
      button.primary {
        font-weight: 650;
      }
    </style>
  </head>
  <body>
    <h1>Quit PwrAgent?</h1>
    <p>${escapeHtml(countText)}</p>
    <p>If you quit now, those turns will be interrupted. You'll need to find each thread when you restart and tell them to continue.</p>
    <p class="countdown" id="countdown"></p>
    <div class="actions">
      <button id="stay" type="button">Stay Open</button>
      <button id="quit" class="primary" type="button" autofocus>Quit Now</button>
    </div>
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
