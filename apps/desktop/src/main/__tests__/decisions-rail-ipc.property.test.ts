import path from "node:path";
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionsRailOpenResultsRequest } from "@pwragent/shared/decisions-rail";
import { DECISIONS_RAIL_OPEN_RESULTS_CHANNEL } from "../../shared/ipc";
import { registerDecisionsRailIpcHandlers } from "../shell/ipc/decisions-rail-ipc";

type ResultsHandler = (event: { sender: object }, request: DecisionsRailOpenResultsRequest) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, ResultsHandler>(),
  fromWebContents: vi.fn(),
  openPath: vi.fn(async () => ""),
  showItemInFolder: vi.fn(),
  isLocalMainWindowWebContents: vi.fn(),
  railResultsFile: vi.fn(),
  showMarkdownFileViewerWindow: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  ipcMain: {
    handle: (channel: string, handler: ResultsHandler) => {
      mocks.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
  },
  shell: { openPath: mocks.openPath, showItemInFolder: mocks.showItemInFolder },
}));

vi.mock("../openai-decisions/openai-decisions-runtime", () => ({
  getOpenAIDecisionsRail: () => ({ railResultsFile: mocks.railResultsFile }),
}));

vi.mock("../shell/window-channels", () => ({
  isLocalMainWindowWebContents: mocks.isLocalMainWindowWebContents,
}));

vi.mock("../shell/markdown-files-window", () => ({
  showMarkdownFileViewerWindow: mocks.showMarkdownFileViewerWindow,
}));

const thread = { backend: "codex", threadId: "fixture-thread" };
const sender = {};
const sourceWindow = {};

function openResults(batchId: string) {
  return mocks.handlers.get(DECISIONS_RAIL_OPEN_RESULTS_CHANNEL)!({ sender }, { ...thread, batchId });
}

async function expectInAppResults(batchId: string, extension: string, shellResult: string) {
  const label = `${batchId}.${extension}`;
  const file = path.resolve("fixture", "decision-batches", label);
  vi.clearAllMocks();
  mocks.openPath.mockResolvedValue(shellResult);
  mocks.railResultsFile.mockResolvedValue(file);

  expect(await openResults(batchId)).toEqual({ opened: true });
  expect(mocks.railResultsFile).toHaveBeenCalledExactlyOnceWith(thread, batchId);
  expect(mocks.openPath).not.toHaveBeenCalled();
  expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  expect(mocks.fromWebContents).toHaveBeenCalledExactlyOnceWith(sender);
  expect(mocks.showMarkdownFileViewerWindow).toHaveBeenCalledExactlyOnceWith({
    context: expect.objectContaining({ key: expect.any(String) }),
    file: { path: file, label },
  }, { sourceWindow });
}

describe("Decisions results file IPC", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isLocalMainWindowWebContents.mockReturnValue(true);
    mocks.fromWebContents.mockReturnValue(sourceWindow);
    registerDecisionsRailIpcHandlers();
  });

  it("opens a JSONL batch in the viewer when the OS has no registered app", async () => {
    await expectInAppResults("batch_fixture", "jsonl", "No application is registered");
  });

  it("routes both JSON Lines extensions to the viewer regardless of OS association", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uuid(),
      fc.constantFrom("jsonl", "ndjson", "JSONL", "NDJSON"),
      fc.constantFrom("", "No application is registered"),
      async (id, extension, shellResult) => {
        await expectInAppResults(`batch_${id}`, extension, shellResult);
      },
    ));
  });

  it("reports a missing results file without opening a window", async () => {
    expect(await openResults("batch_fixture")).toEqual({ opened: false, error: "This batch has no results file." });
    expect(mocks.showMarkdownFileViewerWindow).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it("rejects a non-local window or an invalid batch ID before resolving a path", async () => {
    mocks.isLocalMainWindowWebContents.mockReturnValueOnce(false);
    await expect(openResults("batch_fixture")).rejects.toThrow("Open decisions on the PwrAgent instance that owns them");
    await expect(openResults("../batch_fixture")).rejects.toThrow("Invalid batch id");
    expect(mocks.railResultsFile).not.toHaveBeenCalled();
    expect(mocks.showMarkdownFileViewerWindow).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });
});
