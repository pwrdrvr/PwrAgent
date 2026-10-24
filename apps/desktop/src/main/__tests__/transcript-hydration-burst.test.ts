// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createElement, Fragment } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary, ResolveTranscriptFilesRequest } from "@pwragent/shared";
import { FederationFilePullReader } from "../federation/federation-file-pull";
import { ThreadMarkdown } from "../../renderer/src/features/thread-detail/ThreadMarkdown";
import type { DesktopApi } from "../../renderer/src/lib/desktop-api";
import { scopeDesktopApiToFederationTarget } from "../../renderer/src/lib/federation-desktop-api";

afterEach(cleanup);

describe("remote transcript hydration bursts", () => {
  it("hydrates every mounted message through the real owner reader despite the four-operation limit", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-hydration-burst-")));
    let resume: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    try {
      const names = Array.from({ length: 12 }, (_, index) => `report-${index}.md`);
      await Promise.all(names.map((name) => writeFile(path.join(root, name), "# Fixture report")));
      const thread = { id: "owner-thread", source: "acp:grok", linkedDirectories: [], projectKey: root } as unknown as AppServerThreadSummary;
      const resolveThread = vi.fn(async () => { await gate; return thread; });
      const reader = new FederationFilePullReader({
        permissions: () => ({ filePull: true, filePullOutsideThreadDirectories: false }),
        resolveThread,
      });
      const errors: unknown[] = [];
      const resolveTranscriptFiles = vi.fn(async (request: ResolveTranscriptFilesRequest) => {
        try {
          return await reader.resolveTranscript(request);
        } catch (error) {
          // Match IPC: owner failures become empty results, with no renderer retry.
          errors.push(error);
          return { files: [] };
        }
      });
      const federationTarget = { scope: "remote" as const, instanceId: "owner" };
      const api = scopeDesktopApiToFederationTarget({ resolveTranscriptFiles, readMarkdownFile: vi.fn() } as unknown as DesktopApi, federationTarget);
      const view = render(createElement(Fragment, null, ...names.map((name) => createElement(ThreadMarkdown, {
        key: name,
        desktopApi: api,
        fileViewerContext: {
          key: "owner-thread", title: "Files", projectPath: "/viewer-supplied-root",
          thread: { backend: "acp:grok", threadId: "owner-thread" },
        },
        text: `Read \`${name}\`.`,
      }))));
      await waitFor(() => expect(resolveTranscriptFiles).toHaveBeenCalledTimes(12));
      expect(resolveThread).toHaveBeenCalledTimes(4);
      expect(errors).toEqual([]);
      await act(async () => resume());
      await waitFor(() => expect(view.container.querySelectorAll("a")).toHaveLength(12));
      for (const name of names) {
        expect(view.getByRole("link", { name })).toHaveAttribute("href", `file://${encodeURI(path.join(root, name))}`);
      }
      expect(resolveThread).toHaveBeenCalledTimes(12);
      expect(resolveTranscriptFiles.mock.calls.every(([request]) => request.federationTarget?.scope === "remote"
        && request.federationTarget.instanceId === "owner")).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      resume();
      cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});
