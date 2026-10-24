import { describe, expect, it } from "vitest";
import {
  isThreadLockRefusal,
  normalizeRecentThreadLockNote,
  normalizeThreadLockNote,
  parseRecentThreadLockNotes,
  rememberRecentThreadLockNote,
  THREAD_LOCK_NOTE_MAX_LENGTH,
  THREAD_LOCK_RECENT_NOTE_MAX_LENGTH,
  THREAD_LOCK_RECENT_NOTES_LIMIT,
  threadLockRefusalMessage,
} from "../thread-lock";

describe("thread lock notes", () => {
  it("trims a note and drops a blank one", () => {
    expect(normalizeThreadLockNote("  Handed to the repair thread.\n")).toBe("Handed to the repair thread.");
    expect(normalizeThreadLockNote(" \n ")).toBeUndefined();
    expect(normalizeThreadLockNote(undefined)).toBeUndefined();
  });

  it("caps a note at the maximum length", () => {
    const note = normalizeThreadLockNote("x".repeat(THREAD_LOCK_NOTE_MAX_LENGTH + 50));
    expect(note).toHaveLength(THREAD_LOCK_NOTE_MAX_LENGTH);
  });
});

describe("recent thread lock notes", () => {
  it("offers only short one-line notes", () => {
    expect(normalizeRecentThreadLockNote("  Claude Design ")).toBe("Claude Design");
    expect(normalizeRecentThreadLockNote("Claude\nDesign")).toBeUndefined();
    expect(normalizeRecentThreadLockNote("x".repeat(THREAD_LOCK_RECENT_NOTE_MAX_LENGTH))).toHaveLength(
      THREAD_LOCK_RECENT_NOTE_MAX_LENGTH,
    );
    expect(normalizeRecentThreadLockNote("x".repeat(THREAD_LOCK_RECENT_NOTE_MAX_LENGTH + 1))).toBeUndefined();
    expect(normalizeRecentThreadLockNote(" ")).toBeUndefined();
  });

  it("moves a remembered note to the front without repeats, capped", () => {
    expect(rememberRecentThreadLockNote(["A", "Claude Design", "B"], " Claude Design"))
      .toEqual(["Claude Design", "A", "B"]);
    const full = Array.from({ length: THREAD_LOCK_RECENT_NOTES_LIMIT }, (_, index) => `Note ${index}`);
    expect(rememberRecentThreadLockNote(full, "New")).toEqual(["New", ...full.slice(0, -1)]);
  });

  it("leaves the list alone for a note that does not qualify", () => {
    expect(rememberRecentThreadLockNote(["A"], "Two\nlines")).toEqual(["A"]);
    expect(rememberRecentThreadLockNote(["A"], "")).toEqual(["A"]);
  });

  it("reads a stored list defensively", () => {
    expect(parseRecentThreadLockNotes(["A", 3, "A", " B ", "multi\nline"])).toEqual(["A", "B"]);
    expect(parseRecentThreadLockNotes("A")).toEqual([]);
    expect(parseRecentThreadLockNotes(Array.from({ length: 9 }, (_, index) => `N${index}`)))
      .toHaveLength(THREAD_LOCK_RECENT_NOTES_LIMIT);
  });
});

describe("thread lock refusal", () => {
  it("names the note, punctuating it as a sentence", () => {
    expect(threadLockRefusalMessage({ note: "Worktree handed to another agent" }))
      .toBe("This thread is locked: Worktree handed to another agent. Unlock it before starting a turn.");
    expect(threadLockRefusalMessage({ note: "Don't reply here!" }))
      .toBe("This thread is locked: Don't reply here! Unlock it before starting a turn.");
  });

  it("reads without a note", () => {
    expect(threadLockRefusalMessage({})).toBe("This thread is locked. Unlock it before starting a turn.");
  });

  it("is recognized whatever its note says, even through a wrapping error", () => {
    expect(isThreadLockRefusal(threadLockRefusalMessage({ note: "Repair in progress" }))).toBe(true);
    expect(isThreadLockRefusal(`Remote error: ${threadLockRefusalMessage({})}`)).toBe(true);
    expect(isThreadLockRefusal("A turn is already active on this thread.")).toBe(false);
  });
});
