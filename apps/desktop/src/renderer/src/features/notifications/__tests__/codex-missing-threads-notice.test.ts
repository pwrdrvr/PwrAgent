import { describe, expect, it, vi } from "vitest";
import {
  buildCodexMissingThreadsNotice,
  formatMissingThreadShare,
} from "../codex-missing-threads-notice";

describe("buildCodexMissingThreadsNotice", () => {
  it("asks with both answers, naming the profile and the share", () => {
    const onArchive = vi.fn();
    const onKeep = vi.fn();
    const notice = buildCodexMissingThreadsNotice({
      onArchive,
      onKeep,
      signal: {
        missingCount: 2,
        profileName: "work",
        status: "confirmationRequired",
        threadIds: ["thread-1", "thread-2"],
        totalCount: 5,
      },
    });

    expect(notice).toMatchObject({
      autoDismiss: false,
      id: "codex-missing-threads:confirmation",
      title: "Threads missing from Codex",
      tone: "warning",
    });
    expect(notice?.message).toContain("40%");
    expect(notice?.message).toContain('"work"');
    expect(notice?.message).toContain("2 of 5");
    // The notice replaces the toast's own dismiss control when it carries
    // actions, so the two answers are the only way out of it.
    expect(notice?.actions?.map((action) => action.label)).toEqual([
      "Leave Everything Alone",
      "Archive the Missing Threads",
    ]);

    notice?.actions?.[0]?.onClick();
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();

    notice?.actions?.[1]?.onClick();
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("reports an automatic archive without asking anything", () => {
    const notice = buildCodexMissingThreadsNotice({
      onArchive: vi.fn(),
      onKeep: vi.fn(),
      signal: {
        archivedCount: 1,
        failedCount: 0,
        missingCount: 1,
        profileName: "default",
        status: "archived",
        threadIds: ["thread-1"],
        totalCount: 10,
      },
    });

    expect(notice).toMatchObject({
      id: "codex-missing-threads:archived",
      title: "Archived missing threads",
      tone: "neutral",
    });
    expect(notice?.actions).toBeUndefined();
    expect(notice?.autoDismiss).toBeUndefined();
    expect(notice?.message).toContain("1 thread");
  });

  it("warns when some of the missing threads could not be archived", () => {
    const notice = buildCodexMissingThreadsNotice({
      onArchive: vi.fn(),
      onKeep: vi.fn(),
      signal: {
        archivedCount: 1,
        failedCount: 2,
        missingCount: 3,
        profileName: "default",
        status: "archived",
        threadIds: ["thread-1", "thread-2", "thread-3"],
        totalCount: 20,
      },
    });

    expect(notice?.tone).toBe("warning");
    expect(notice?.detail).toContain("2 threads could not be archived");
  });

  it("produces nothing when there is no thread to report", () => {
    expect(
      buildCodexMissingThreadsNotice({
        onArchive: vi.fn(),
        onKeep: vi.fn(),
        signal: {
          missingCount: 0,
          profileName: "default",
          status: "confirmationRequired",
          threadIds: [],
          totalCount: 10,
        },
      }),
    ).toBeUndefined();
  });
});

describe("formatMissingThreadShare", () => {
  it("rounds to whole percents", () => {
    expect(formatMissingThreadShare({ missingCount: 1, totalCount: 3 }))
      .toBe("33%");
  });

  it("never rounds a partial loss up to the whole profile", () => {
    expect(formatMissingThreadShare({ missingCount: 999, totalCount: 1_000 }))
      .toBe("99%");
    expect(formatMissingThreadShare({ missingCount: 10, totalCount: 10 }))
      .toBe("100%");
  });

  it("never reports a real loss as 0%", () => {
    expect(formatMissingThreadShare({ missingCount: 1, totalCount: 1_000 }))
      .toBe("1%");
  });
});
