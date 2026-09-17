/**
 * The retry behind every fixture's temp-root teardown.
 *
 * The defect this guards reproduces about 1 in 30 Windows E2E runs, and it
 * does not fail where it happens: the teardown error is attributed to
 * whichever spec Playwright retries next, so CI run 34977635883 reported a
 * bare 30s `a11y` timeout for what was an `EBUSY` on `state.db`. A refactor
 * that dropped the retry would therefore go unnoticed for weeks and then
 * present as an unrelated spec being slow.
 *
 * It lives here rather than beside the fixture for the same reason
 * `capture-window-placement.test.ts` does: `e2e/` is Playwright's `testDir`
 * and its default `testMatch` claims `*.test.ts`.
 */

import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TEMP_ROOT_REMOVAL_MAX_RETRIES,
  TEMP_ROOT_REMOVAL_RETRY_DELAY_MS,
  removeTempRoot,
} from "../../../e2e/fixtures/temp-root-cleanup";

async function seededRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-temp-root-test-"));
  await writeFile(path.join(root, "state.db"), "x", "utf8");
  return root;
}

describe("removeTempRoot", () => {
  it("removes the tree and stays silent on the common path", async () => {
    const root = await seededRoot();
    const warn = vi.fn();
    await removeTempRoot(root, { warn });
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
    // The first attempt is unretried precisely so a clean teardown cannot be
    // confused with one that needed the retry.
    expect(warn).not.toHaveBeenCalled();
  });

  it("is idempotent on a root that is already gone", async () => {
    const root = await seededRoot();
    await removeTempRoot(root);
    await expect(removeTempRoot(root)).resolves.toBeUndefined();
  });

  it("keeps the retry budget inside the teardown ceiling", () => {
    // Node waits `retries * retryDelay` before each attempt.
    const worstCaseMs = Array.from(
      { length: TEMP_ROOT_REMOVAL_MAX_RETRIES },
      (_unused, index) => (index + 1) * TEMP_ROOT_REMOVAL_RETRY_DELAY_MS,
    ).reduce((total, delay) => total + delay, 0);
    expect(worstCaseMs).toBe(1_800);
    // `ELECTRON_TEARDOWN_TIMEOUT_MS` is 20s against a ~14s worst-case close.
    expect(worstCaseMs).toBeLessThan(20_000 - 14_000);
  });

  it("warns before retrying a retryable errno, then rethrows if it persists", async () => {
    const warn = vi.fn();
    const root = path.join(os.tmpdir(), "pwragent-temp-root-never-exists");
    const busy = Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    const rm = vi.fn()
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy);
    vi.doMock("node:fs/promises", () => ({ rm }));
    vi.resetModules();
    const { removeTempRoot: subject } = await import(
      "../../../e2e/fixtures/temp-root-cleanup"
    );
    await expect(subject(root, { warn })).rejects.toMatchObject({ code: "EBUSY" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("EBUSY");
    // Second call carries the retry options; the first deliberately does not.
    expect(rm.mock.calls[0]?.[1]).not.toHaveProperty("maxRetries");
    expect(rm.mock.calls[1]?.[1]).toMatchObject({
      maxRetries: TEMP_ROOT_REMOVAL_MAX_RETRIES,
      retryDelay: TEMP_ROOT_REMOVAL_RETRY_DELAY_MS,
    });
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  it("rethrows a non-retryable errno without retrying", async () => {
    const warn = vi.fn();
    const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const rm = vi.fn().mockRejectedValue(denied);
    vi.doMock("node:fs/promises", () => ({ rm }));
    vi.resetModules();
    const { removeTempRoot: subject } = await import(
      "../../../e2e/fixtures/temp-root-cleanup"
    );
    await expect(subject("/nowhere", { warn })).rejects.toMatchObject({ code: "EACCES" });
    expect(rm).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });
});
