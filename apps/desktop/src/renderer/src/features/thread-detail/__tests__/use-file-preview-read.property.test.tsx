import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReadMarkdownFileResponse } from "@pwragent/shared/contracts/settings";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useFilePreviewRead } from "../useFilePreviewRead";

const path = "/repo/report.md";
const thread = { backend: "codex" as const, threadId: "reader" };
const owner = { scope: "remote" as const, instanceId: "owner" };
type Reader = DesktopApi["readMarkdownFile"];
type Failure = "reject" | "error" | "missing";
type Timing = "before-disconnect" | "offline" | "after-reconnect";

afterEach(cleanup);

// Model: an admitted read survives connection churn while pending or loaded.
// If that read fails, one transport recovery permits one replacement read.
async function checkRecovery(failure: Failure, timing: Timing, replaceReader: boolean) {
  let resolve!: (response: ReadMarkdownFileResponse) => void;
  let reject!: (error: Error) => void;
  const read = vi.fn<NonNullable<Reader>>()
    .mockImplementationOnce(() => new Promise((finish, fail) => { resolve = finish; reject = fail; }))
    .mockResolvedValue({ path, content: "Recovered document" });
  const recoveredReader: Reader = replaceReader ? (request) => read(request) : read;
  const view = renderHook(({ reader }: { reader: Reader }) => useFilePreviewRead(reader, path, thread, owner), {
    initialProps: { reader: read as Reader },
  });
  const failRead = async () => {
    await act(async () => {
      if (failure === "reject") reject(new Error("Owner disconnected"));
      else resolve(failure === "error" ? { path, error: "Owner disconnected" } : { path });
    });
  };
  try {
    expect(read).toHaveBeenCalledTimes(1);
    if (timing === "before-disconnect") await failRead();
    await act(async () => view.rerender({ reader: undefined }));
    if (timing === "offline") await failRead();
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => view.rerender({ reader: recoveredReader }));
    if (timing === "after-reconnect") {
      expect(read).toHaveBeenCalledTimes(1);
      await failRead();
    }
    expect(view.result.current).toEqual({ status: "loaded", content: "Recovered document" });
    expect(read).toHaveBeenCalledTimes(2);
    // Further disconnects cannot repeat the successful replacement read.
    await act(async () => view.rerender({ reader: undefined }));
    await act(async () => view.rerender({ reader: read }));
    expect(view.result.current).toEqual({ status: "loaded", content: "Recovered document" });
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
  }
}

describe("file preview read recovery", () => {
  it("retries an interrupted RPC when the same reader becomes available again", async () => {
    await checkRecovery("reject", "offline", false);
  });

  it("recovers failed reads regardless of failure shape and reconnect ordering", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<Failure>("reject", "error", "missing"),
      fc.constantFrom<Timing>("before-disconnect", "offline", "after-reconnect"),
      fc.boolean(),
      checkRecovery,
    ), { numRuns: 25 });
  });

  it("does not loop on a failed read without a transport change", async () => {
    const read = vi.fn(async () => ({ path, error: "File could not be read" }));
    const view = renderHook(() => useFilePreviewRead(read, path, thread, owner));
    await act(async () => undefined);
    expect(view.result.current.status).toBe("error");
    view.rerender();
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("allows only one failed replacement per transport recovery", async () => {
    const read = vi.fn(async () => ({ path, error: "Still unavailable" }));
    const view = renderHook(({ reader }: { reader: Reader }) => useFilePreviewRead(reader, path, thread, owner), {
      initialProps: { reader: read as Reader },
    });
    await act(async () => undefined);
    for (let recovery = 1; recovery <= 3; recovery += 1) {
      await act(async () => view.rerender({ reader: undefined }));
      await act(async () => view.rerender({ reader: read }));
      expect(view.result.current.status).toBe("error");
      expect(read).toHaveBeenCalledTimes(recovery + 1);
      view.rerender({ reader: read });
      await act(async () => undefined);
      expect(read).toHaveBeenCalledTimes(recovery + 1);
    }
  });
});
