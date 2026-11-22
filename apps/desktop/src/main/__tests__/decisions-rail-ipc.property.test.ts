import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const PREVIEW_LIMIT_BYTES = 2 * 1024 * 1024;
let resultsDirectory: string;

function openResults(batchId: string) {
  return mocks.handlers.get(DECISIONS_RAIL_OPEN_RESULTS_CHANNEL)!({ sender }, { ...thread, batchId });
}

async function expectInAppResults(batchId: string, extension: string, shellResult: string) {
  const label = `${batchId}.${extension}`;
  const file = path.join(resultsDirectory, label);
  await writeFile(file, '{"type":"batch"}\n');
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

async function expectCorrectResultsDestination(extraBytes: number) {
  const batchId = "batch_preview-limit";
  const file = path.join(resultsDirectory, `${batchId}.jsonl`);
  const count = 500;
  const header = { type: "batch", format: 1, batchId, decisionId: "label-check", name: "label_check", version: 1, provider: "jev", count, createdAt: 1 };
  const end = { type: "end", state: "completed", succeeded: count, failed: 0, skipped: 0, finishedAt: 2 };
  const items = Array.from({ length: count }, (_, index) => ({ type: "item", index, ok: true, response: { explanation: "" } }));
  const serialize = () => [header, ...items, end].map((line) => `${JSON.stringify(line)}\n`).join("");
  const responseBytes = PREVIEW_LIMIT_BYTES + extraBytes - Buffer.byteLength(serialize());
  // Use multibyte text so a character count would misclassify these files.
  const perItem = Math.floor(responseBytes / count / 2);
  for (const item of items) item.response.explanation = "é".repeat(perItem);
  items[0]!.response.explanation += "a".repeat(responseBytes - perItem * count * 2);
  const content = serialize();
  expect(Buffer.byteLength(content)).toBe(PREVIEW_LIMIT_BYTES + extraBytes);
  await writeFile(file, content);
  vi.clearAllMocks();
  mocks.railResultsFile.mockResolvedValue(file);

  // The limit is inclusive. Over it, show the file in its folder without
  // invoking an OS opener or loading the oversized file into the viewer.
  expect(await openResults(batchId)).toEqual({ opened: true });
  expect(mocks.openPath).not.toHaveBeenCalled();
  if (extraBytes > 0) {
    expect(mocks.showItemInFolder).toHaveBeenCalledExactlyOnceWith(file);
    expect(mocks.showMarkdownFileViewerWindow).not.toHaveBeenCalled();
  } else {
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
    expect(mocks.showMarkdownFileViewerWindow).toHaveBeenCalledOnce();
  }
}

describe("Decisions results file IPC", () => {
  beforeEach(async () => {
    resultsDirectory = await mkdtemp(path.join(os.tmpdir(), "pwragent-decision-results-"));
    vi.resetAllMocks();
    mocks.isLocalMainWindowWebContents.mockReturnValue(true);
    mocks.fromWebContents.mockReturnValue(sourceWindow);
    registerDecisionsRailIpcHandlers();
  });

  afterEach(async () => {
    await rm(resultsDirectory, { recursive: true, force: true });
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

  it("previews a batch at exactly 2 MiB and reveals it one byte above the limit", async () => {
    await expectCorrectResultsDestination(0);
    await expectCorrectResultsDestination(1);
  });

  it("chooses the viewer or file manager from the batch's UTF-8 byte size", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8192 }), async (distance) => {
      await expectCorrectResultsDestination(-distance);
      await expectCorrectResultsDestination(distance);
    }), { numRuns: 15 });
  });

  it.each([false, true])("reports a missing results file without opening a window (stale path: %s)", async (stalePath) => {
    if (stalePath) mocks.railResultsFile.mockResolvedValue(path.join(resultsDirectory, "batch_fixture.jsonl"));
    expect(await openResults("batch_fixture")).toEqual({ opened: false, error: "This batch has no results file." });
    expect(mocks.showMarkdownFileViewerWindow).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
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
