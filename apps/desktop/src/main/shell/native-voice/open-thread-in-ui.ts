import type { WebContents } from "electron";
import type { OpenThreadToolArgs, OperatorFocusSnapshot, PwrAgentStarMapResponse } from "@pwragent/shared";
import { primaryMainWindowWebContents } from "../primary-main-window";
import { requestShowThread } from "../window-show-thread";
import { currentOperatorFocusWebContents, observeOperatorFocus } from "./operator-focus-registry";

type OpenThreadResponse = PwrAgentStarMapResponse<"open_thread">;

export type OpenThreadInUiDeps = {
  localInstanceId: () => Promise<string | undefined>;
  window?: () => WebContents | undefined;
  send?: typeof requestShowThread;
  timeoutMs?: number;
};

/** The peer owns the thread; the local operator's window owns navigation. */
export function createOpenThreadInUi(deps: OpenThreadInUiDeps): (args: OpenThreadToolArgs) => Promise<OpenThreadResponse> {
  return async (args) => {
    const webContents = deps.window
      ? deps.window()
      : currentOperatorFocusWebContents() ?? primaryMainWindowWebContents();
    if (!webContents || webContents.isDestroyed()) {
      return { ok: false, error: { code: "ui_not_available", message: "No local PwrAgent main window is available to open the thread." } };
    }
    const localId = args.instanceId ? await deps.localInstanceId() : undefined;
    const instanceId = args.instanceId && args.instanceId !== localId ? args.instanceId : undefined;
    const matches = (focus: OperatorFocusSnapshot | undefined): focus is OperatorFocusSnapshot =>
      focus?.view === "thread"
      && focus.thread?.backend === args.backend
      && focus.thread.threadId === args.threadId
      && focus.thread.instanceId === instanceId;

    return await new Promise<OpenThreadResponse>((resolve) => {
      let settled = false;
      const settle = (response: OpenThreadResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        webContents.removeListener("destroyed", onDestroyed);
        resolve(response);
      };
      const onDestroyed = (): void => settle({
        ok: false, error: { code: "ui_not_available", message: "The PwrAgent main window closed before navigation was confirmed." },
      });
      const unsubscribe = observeOperatorFocus((entry) => {
        if (entry.webContents.id === webContents.id && matches(entry.focus)) {
          settle({ ok: true, data: { focus: entry.focus } });
        }
      });
      const timer = setTimeout(() => settle({
        ok: false,
        error: {
          code: "navigation_timeout",
          message: "The main window did not confirm the requested thread selection. The thread may be unavailable; do not report it as opened.",
        },
      }), deps.timeoutMs ?? 15_000);
      webContents.once("destroyed", onDestroyed);
      try {
        const sent = (deps.send ?? requestShowThread)({
          backend: args.backend,
          threadId: args.threadId,
          ...(instanceId ? { federationTarget: { scope: "remote", instanceId } } : {}),
        }, { preferWebContents: webContents, requirePreferred: true });
        if (sent !== webContents) {
          settle({ ok: false, error: { code: "ui_not_available", message: "The local main window is not ready to receive thread navigation." } });
          return;
        }
      } catch (error) {
        settle({ ok: false, error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } });
      }
    });
  };
}
