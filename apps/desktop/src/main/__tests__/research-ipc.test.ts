import { afterEach, expect, it, vi } from "vitest";
import { RESEARCH_PREPARE_CHANNEL } from "../../shared/ipc";

const control = vi.hoisted(() => ({
  enabled: false,
  discovery: true,
  prepare: vi.fn(() => ({ intentId: "operator-request" })),
  handlers: new Map<string, (event: { sender: unknown }, request: unknown) => unknown>(),
}));
vi.mock("electron", () => ({ ipcMain: {
  handle: (name: string, handler: (event: { sender: unknown }, request: unknown) => unknown) => control.handlers.set(name, handler),
  removeHandler: (name: string) => control.handlers.delete(name),
}, shell: { openPath: vi.fn() } }));
vi.mock("../shell/window-channels", () => ({ isLocalMainWindowWebContents: () => true }));
vi.mock("../settings/desktop-settings-singleton", () => ({ getDesktopSettingsService: () => ({ resolveResearchEnabled: () => control.enabled, resolveCodexToolDiscovery: () => control.discovery }) }));
vi.mock("../research/research-runtime", () => ({ getResearchService: () => ({ prepare: control.prepare }) }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: vi.fn() }));

import { registerResearchIpcHandlers, disposeResearchIpcHandlers } from "../shell/ipc/research-ipc";

afterEach(() => { disposeResearchIpcHandlers(); control.enabled = false; control.discovery = true; control.prepare.mockClear(); });

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

it("the research window accepts a local thread of every backend and refuses anything that is not a backend", () => {
  registerResearchIpcHandlers();
  const handler = control.handlers.get(RESEARCH_PREPARE_CHANNEL)!;
  control.enabled = true;
  for (const backend of ["codex", "claude", "acp:kimi", "acp:grok"]) {
    control.prepare.mockClear();
    expect(handler({ sender: {} }, { backend, threadId: "parent" })).toEqual({ intentId: "operator-request" });
    expect(control.prepare).toHaveBeenCalledOnce();
  }
  for (const backend of ["", "Codex", "acp:", "openai", 7, undefined]) {
    control.prepare.mockClear();
    expect(() => handler({ sender: {} }, { backend, threadId: "parent" })).toThrow("Choose a local thread");
    expect(control.prepare).not.toHaveBeenCalled();
  }
});

it("a Codex thread cannot prepare a run its coordinator would never be offered research_start for", () => {
  registerResearchIpcHandlers();
  const handler = control.handlers.get(RESEARCH_PREPARE_CHANNEL)!;
  control.enabled = true;
  for (const discovery of [true, false]) {
    control.discovery = discovery;
    for (const backend of ["codex", "claude", "acp:kimi"]) {
      control.prepare.mockClear();
      const call = () => handler({ sender: {} }, { backend, threadId: "parent" });
      if (backend === "codex" && !discovery) { expect(call).toThrow("Codex Tool Discovery"); expect(control.prepare).not.toHaveBeenCalled(); }
      else { expect(call()).toEqual({ intentId: "operator-request" }); expect(control.prepare).toHaveBeenCalledOnce(); }
    }
  }
});
