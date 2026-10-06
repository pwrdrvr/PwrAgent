import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerApplicationIpcHandlers } from "../ipc/applications";
import { MARKDOWN_FILE_READ_CHANNEL } from "../../shared/ipc";
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
    enabled: { value: false, source: "default" },
    path: { value: "", source: "default" },
    discovery: { candidates: [] },
  },
  git: {
    path: { value: "", source: "default" },
    discovery: { candidates: [] },
  },
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
    showThreadFromToolOutputIncidentExplorer: vi.fn(),
    showToolOutputIncidentExplorerWindow: vi.fn(),
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

vi.mock("../tool-output-incident-explorer-window", () => ({
  showThreadFromToolOutputIncidentExplorer:
    mocks.showThreadFromToolOutputIncidentExplorer,
  showToolOutputIncidentExplorerWindow:
    mocks.showToolOutputIncidentExplorerWindow,
}));

describe("application IPC", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.openApplication.mockClear();
    mocks.readApplications.mockClear();
    mocks.discoverDesktopApplications.mockClear();
    mocks.openDesktopApplication.mockClear();
    mocks.remoteBackendForTarget.mockClear();
    mocks.showThreadFromToolOutputIncidentExplorer.mockClear();
    mocks.showToolOutputIncidentExplorerWindow.mockClear();
  });

  it("reads local JSON previews and rejects unsupported, missing, directory and oversized paths", async () => {
    registerApplicationIpcHandlers();
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-json-preview-"));
    const read = (filePath: string) => mocks.handlers.get(MARKDOWN_FILE_READ_CHANNEL)?.({}, { path: filePath });
    try {
      const filePath = path.join(root, "widget.JSON");
      const content = '{"title":"Widget","id":9007199254740993}';
      await writeFile(filePath, content);
      expect(await read(filePath)).toEqual({ path: filePath, content });
      expect(await read(path.join(root, "script.js"))).toMatchObject({ error: "Only Markdown and JSON files can be previewed." });
      expect(await read(path.join(root, "missing.json"))).toMatchObject({ error: expect.stringContaining("does not exist") });
      const directory = path.join(root, "directory.json");
      await mkdir(directory);
      expect(await read(directory)).toMatchObject({ error: expect.stringContaining("not a file") });
      await writeFile(filePath, Buffer.alloc(2 * 1024 * 1024 + 1));
      expect(await read(filePath)).toMatchObject({ error: "File is too large to preview." });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens applications on the selected federation peer", async () => {
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

  it("opens the thread-scoped tool-output incident explorer", async () => {
    const { TOOL_OUTPUT_INCIDENT_EXPLORER_WINDOW_OPEN_CHANNEL } = await import(
      "../../shared/ipc"
    );
    registerApplicationIpcHandlers();

    const response = await mocks.handlers.get(
      TOOL_OUTPUT_INCIDENT_EXPLORER_WINDOW_OPEN_CHANNEL,
    )?.({ sender: "sender" }, {
      backend: "codex",
      threadId: "thread-1",
      title: "Noisy work",
    });

    expect(mocks.showToolOutputIncidentExplorerWindow).toHaveBeenCalledWith(
      {
        backend: "codex",
        threadId: "thread-1",
        title: "Noisy work",
      },
      { sourceWindow: undefined },
    );
    expect(response).toEqual({ opened: true });
  });

  it("routes incident-explorer thread navigation through its owner", async () => {
    const { TOOL_OUTPUT_INCIDENT_EXPLORER_SHOW_THREAD_CHANNEL } = await import(
      "../../shared/ipc"
    );
    registerApplicationIpcHandlers();
    const sender = { id: 42 };
    const request = { backend: "codex" as const, threadId: "thread-1" };

    await mocks.handlers.get(
      TOOL_OUTPUT_INCIDENT_EXPLORER_SHOW_THREAD_CHANNEL,
    )?.({ sender }, request);

    expect(mocks.showThreadFromToolOutputIncidentExplorer)
      .toHaveBeenCalledWith(sender, request);
  });
});
