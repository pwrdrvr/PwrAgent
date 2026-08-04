import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopApplicationsSnapshot,
  OpenDesktopApplicationRequest,
  OpenDesktopApplicationResponse,
  ReadDesktopApplicationsRequest,
} from "@pwragent/shared";

const remoteApplications: DesktopApplicationsSnapshot = {
  editors: [],
  terminals: [{
    id: "terminal",
    kind: "terminal",
    name: "Terminal",
    source: "application",
    appPath: "/System/Applications/Utilities/Terminal.app",
    canOpenWorkspace: true,
  }],
  preferredEditorId: { value: "", source: "default" },
  preferredTerminalId: { value: "", source: "default" },
  gh: {
    path: { value: "", source: "default" },
    discovery: { candidates: [] },
  },
  git: { discovery: { candidates: [] } },
};

const mocks = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (...args: unknown[]) => Promise<unknown>
  >();
  const openApplication = vi.fn(
    async (): Promise<OpenDesktopApplicationResponse> => ({ opened: true }),
  );
  const readApplications = vi.fn(async () => remoteApplications);
  const remoteBackend = { openApplication, readApplications };
  return {
    handlers,
    openApplication,
    readApplications,
    discoverDesktopApplications: vi.fn(async () => remoteApplications),
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
  discoverDesktopApplications: mocks.discoverDesktopApplications,
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
    mocks.readApplications.mockClear();
    mocks.discoverDesktopApplications.mockClear();
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

  it("reads application candidates from the selected federation peer", async () => {
    const { registerApplicationIpcHandlers } = await import("../ipc/applications");
    const { APPLICATIONS_READ_CHANNEL } = await import("../../shared/ipc");
    registerApplicationIpcHandlers();

    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const response = await mocks.handlers.get(APPLICATIONS_READ_CHANNEL)?.({}, {
      federationTarget,
    } satisfies ReadDesktopApplicationsRequest);

    expect(mocks.remoteBackendForTarget).toHaveBeenCalledWith(federationTarget);
    expect(mocks.readApplications).toHaveBeenCalledTimes(1);
    expect(mocks.discoverDesktopApplications).not.toHaveBeenCalled();
    expect(response).toEqual({ applications: remoteApplications });
  });
});
