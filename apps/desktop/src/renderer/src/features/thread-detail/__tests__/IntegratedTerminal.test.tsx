import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { IntegratedTerminal } from "../IntegratedTerminal";

const xtermState = vi.hoisted(() => ({
  instances: [] as Array<{
    cols: number;
    rows: number;
    focus: ReturnType<typeof vi.fn>;
    handlers: Array<(data: string) => void>;
    emitData: (data: string) => void;
  }>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    focus = vi.fn();
    handlers: Array<(data: string) => void> = [];

    constructor() {
      xtermState.instances.push(this);
    }

    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    dispose = vi.fn();

    onData(callback: (data: string) => void) {
      this.handlers.push(callback);
      return { dispose: vi.fn() };
    }

    emitData(data: string) {
      for (const handler of this.handlers) {
        handler(data);
      }
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 100, rows: 22 }));
  },
}));

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

describe("IntegratedTerminal", () => {
  beforeEach(() => {
    xtermState.instances.length = 0;
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: MockResizeObserver,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("buffers user input until the pty session attaches", async () => {
    let resolveCreate: (
      value: Awaited<ReturnType<NonNullable<DesktopApi["createIntegratedTerminal"]>>>,
    ) => void = () => undefined;
    const createIntegratedTerminal = vi.fn(
      () =>
        new Promise<
          Awaited<ReturnType<NonNullable<DesktopApi["createIntegratedTerminal"]>>>
        >((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const writeIntegratedTerminal = vi.fn(async () => undefined);

    render(
      <IntegratedTerminal
        desktopApi={{
          createIntegratedTerminal,
          writeIntegratedTerminal,
          resizeIntegratedTerminal: vi.fn(async () => undefined),
          onIntegratedTerminalOutput: vi.fn(() => () => undefined),
          onIntegratedTerminalExit: vi.fn(() => () => undefined),
          onIntegratedTerminalError: vi.fn(() => () => undefined),
        }}
        threadKey="codex:thread-a"
        cwd="/repo/a"
        height={260}
        onHeightChange={() => undefined}
        onClose={() => undefined}
        onExit={() => undefined}
      />,
    );

    await waitFor(() => expect(xtermState.instances).toHaveLength(1));

    act(() => {
      xtermState.instances[0]!.emitData("exit\r");
    });
    expect(writeIntegratedTerminal).not.toHaveBeenCalled();

    await act(async () => {
      resolveCreate({
        sessionId: "session-1",
        threadKey: "codex:thread-a",
        cwd: "/repo/a",
        shell: "/bin/zsh",
      });
    });

    await waitFor(() => {
      expect(writeIntegratedTerminal).toHaveBeenCalledWith({
        sessionId: "session-1",
        data: "exit\r",
      });
    });
  });
});
