import { afterEach, expect, it, vi } from "vitest";
import { RESEARCH_PREPARE_CHANNEL } from "../../shared/ipc";

const control = vi.hoisted(() => ({
  enabled: false,
  prepare: vi.fn(() => ({ intentId: "operator-request" })),
  handlers: new Map<string, (event: { sender: unknown }, request: unknown) => unknown>(),
}));
vi.mock("electron", () => ({ ipcMain: {
  handle: (name: string, handler: (event: { sender: unknown }, request: unknown) => unknown) => control.handlers.set(name, handler),
  removeHandler: (name: string) => control.handlers.delete(name),
}, shell: { openPath: vi.fn() } }));
vi.mock("../shell/window-channels", () => ({ isLocalMainWindowWebContents: () => true }));
vi.mock("../settings/desktop-settings-singleton", () => ({ getDesktopSettingsService: () => ({ resolveResearchEnabled: () => control.enabled }) }));
vi.mock("../research/research-runtime", () => ({ getResearchService: () => ({ prepare: control.prepare }) }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: vi.fn() }));

import { registerResearchIpcHandlers, disposeResearchIpcHandlers } from "../shell/ipc/research-ipc";

afterEach(() => { disposeResearchIpcHandlers(); control.enabled = false; control.prepare.mockClear(); });

it("a stale renderer IPC handler consults the live default-off research gate before accessing research", () => {
  registerResearchIpcHandlers();
  const handler = control.handlers.get(RESEARCH_PREPARE_CHANNEL)!;
  for (const enabled of [false, true, false]) {
    control.enabled = enabled;
    const calls = control.prepare.mock.calls.length;
    const call = () => handler({ sender: {} }, { backend: "codex", threadId: "parent" });
    if (enabled) { expect(call()).toEqual({ intentId: "operator-request" }); expect(control.prepare).toHaveBeenCalledTimes(calls + 1); }
    else { expect(call).toThrow("Research runs are disabled"); expect(control.prepare).toHaveBeenCalledTimes(calls); }
  }
});
