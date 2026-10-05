import { describe, expect, it } from "vitest";
import {
  normalizeThreadLockNote,
  THREAD_LOCK_NOTE_MAX_LENGTH,
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
});
