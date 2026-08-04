import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OpenDesktopApplicationRequest,
  OpenDesktopApplicationResponse,
} from "@pwragent/shared";

const mocks = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (...args: unknown[]) => Promise<unknown>
  >();
  const openApplication = vi.fn(
    async (): Promise<OpenDesktopApplicationResponse> => ({ opened: true }),
  );
  const remoteBackend = { openApplication };
  return {
    handlers,
    openApplication,
    openDesktopApplication: vi.fn(
      async (): Promise<OpenDesktopApplicationResponse> => ({ opened: true }),
    ),
    remoteBackend,
    remoteBackendForTarget: vi.fn(() => remoteBackend),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        mocks.handlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      mocks.handlers.delete(channel);
    }),
  },
  shell: {
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
  },
}));

vi.mock("../settings/application-discovery", () => ({
  openDesktopApplication: mocks.openDesktopApplication,
}));

vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: () => ({
    remoteBackend: mocks.remoteBackendForTarget,
  }),
}));

vi.mock("../markdown-files-window", () => ({
  readMarkdownFileViewerSnapshot: vi.fn(),
  showMarkdownFileViewerWindow: vi.fn(),
}));

vi.mock("../subagent-transcript-window", () => ({
  showSubAgentTranscriptWindow: vi.fn(),
}));

describe("application IPC", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.openApplication.mockClear();
    mocks.openDesktopApplication.mockClear();
    mocks.remoteBackendForTarget.mockClear();
  });

  it("opens applications on the selected federation peer", async () => {
    const { registerApplicationIpcHandlers } = await import("../ipc/applications");
    const { APPLICATION_OPEN_CHANNEL } = await import("../../shared/ipc");
    registerApplicationIpcHandlers();

    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const response = await mocks.handlers.get(APPLICATION_OPEN_CHANNEL)?.({}, {
      applicationId: "terminal",
      federationTarget,
      kind: "terminal",
      targetPath: "/remote/repo",
    } satisfies OpenDesktopApplicationRequest);

    expect(mocks.remoteBackendForTarget).toHaveBeenCalledWith(federationTarget);
    expect(mocks.openApplication).toHaveBeenCalledWith({
      applicationId: "terminal",
      kind: "terminal",
      targetPath: "/remote/repo",
    });
    expect(mocks.openDesktopApplication).not.toHaveBeenCalled();
    expect(response).toEqual({ opened: true });
  });
});
