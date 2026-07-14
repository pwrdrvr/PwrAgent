import { afterEach, describe, expect, it } from "vitest";
import {
  formatPrimaryAccel,
  isAccelLetter,
  matchFindChord,
  matchHistoryNavChord,
  matchLayoutChord,
  matchThreadJumpChord,
} from "../keyboard-accel";

type PwrWindow = Window & { pwragent?: { platform?: string } };

function setPlatform(platform: string | undefined): void {
  const win = window as PwrWindow;
  if (platform === undefined) {
    delete win.pwragent;
    return;
  }
  win.pwragent = { platform };
}

afterEach(() => {
  setPlatform(undefined);
});

describe("formatPrimaryAccel", () => {
  it("renders ⌘/⌥ glyphs on macOS", () => {
    setPlatform("darwin");
    expect(formatPrimaryAccel("B")).toBe("⌘B");
    expect(formatPrimaryAccel("B", { alt: true })).toBe("⌘⌥B");
  });

  it("renders Ctrl/Alt words on Windows", () => {
    setPlatform("win32");
    expect(formatPrimaryAccel("B")).toBe("Ctrl+B");
    expect(formatPrimaryAccel("B", { alt: true })).toBe("Ctrl+Alt+B");
  });

  it("renders Ctrl/Alt words on Linux", () => {
    setPlatform("linux");
    expect(formatPrimaryAccel("B")).toBe("Ctrl+B");
    expect(formatPrimaryAccel("B", { alt: true })).toBe("Ctrl+Alt+B");
  });

  it("falls back to the Ctrl form when the desktop bridge is unavailable", () => {
    setPlatform(undefined);
    expect(formatPrimaryAccel("B")).toBe("Ctrl+B");
    expect(formatPrimaryAccel("B", { alt: true })).toBe("Ctrl+Alt+B");
  });
});

describe("isAccelLetter", () => {
  const keydown = (init: KeyboardEventInit): KeyboardEvent =>
    new KeyboardEvent("keydown", init);

  it("matches the physical key when Option composes a glyph (⌘⌥B → key '∫')", () => {
    // The regression: macOS rewrites event.key to "∫" while Option is held,
    // so the old `event.key === "b"` check never fired for ⌘⌥B (toggle rail).
    expect(
      isAccelLetter(keydown({ code: "KeyB", key: "∫", altKey: true }), "b"),
    ).toBe(true);
  });

  it("matches a plain letter when code is absent (defensive fallback)", () => {
    expect(isAccelLetter(keydown({ code: "", key: "b" }), "b")).toBe(true);
    expect(isAccelLetter(keydown({ code: "", key: "B" }), "b")).toBe(true);
  });

  it("matches ⌘B (no Option) via either code or key", () => {
    expect(isAccelLetter(keydown({ code: "KeyB", key: "b" }), "b")).toBe(true);
  });

  it("rejects other keys, including other Option-composed glyphs", () => {
    expect(isAccelLetter(keydown({ code: "KeyA", key: "a" }), "b")).toBe(false);
    expect(
      isAccelLetter(keydown({ code: "KeyV", key: "√", altKey: true }), "b"),
    ).toBe(false);
  });
});

describe("matchLayoutChord", () => {
  const keydown = (init: KeyboardEventInit): KeyboardEvent =>
    new KeyboardEvent("keydown", init);

  it("classifies ⌘B / ⌃B as the sidebar chord", () => {
    expect(
      matchLayoutChord(keydown({ metaKey: true, code: "KeyB", key: "b" })),
    ).toBe("sidebar");
    expect(
      matchLayoutChord(keydown({ ctrlKey: true, code: "KeyB", key: "b" })),
    ).toBe("sidebar");
  });

  it("classifies ⌘⌥B as the rail chord even when Option composes the key", () => {
    // macOS delivers key "∫" while Option is held — the chord must still match.
    expect(
      matchLayoutChord(
        keydown({ metaKey: true, altKey: true, code: "KeyB", key: "∫" }),
      ),
    ).toBe("rail");
    expect(
      matchLayoutChord(
        keydown({ ctrlKey: true, altKey: true, code: "KeyB", key: "b" }),
      ),
    ).toBe("rail");
  });

  it("returns null without the primary modifier or for other keys", () => {
    expect(matchLayoutChord(keydown({ code: "KeyB", key: "b" }))).toBe(null);
    // Both Cmd and Ctrl held → not a single primary accelerator.
    expect(
      matchLayoutChord(
        keydown({ metaKey: true, ctrlKey: true, code: "KeyB", key: "b" }),
      ),
    ).toBe(null);
    expect(
      matchLayoutChord(keydown({ metaKey: true, code: "KeyA", key: "a" })),
    ).toBe(null);
  });

  it("returns null while typing in an editable field", () => {
    const event = keydown({ metaKey: true, code: "KeyB", key: "b" });
    Object.defineProperty(event, "target", {
      value: document.createElement("input"),
    });
    expect(matchLayoutChord(event)).toBe(null);
  });
});

describe("matchFindChord", () => {
  const keydown = (init: KeyboardEventInit): KeyboardEvent =>
    new KeyboardEvent("keydown", init);
  const inEditable = (event: KeyboardEvent): KeyboardEvent => {
    Object.defineProperty(event, "target", {
      value: document.createElement("input"),
    });
    return event;
  };

  it("classifies ⌘F / ⌃F as the context find chord", () => {
    expect(matchFindChord(keydown({ metaKey: true, code: "KeyF", key: "f" }))).toBe(
      "find",
    );
    expect(matchFindChord(keydown({ ctrlKey: true, code: "KeyF", key: "f" }))).toBe(
      "find",
    );
  });

  it("classifies ⌘⇧F as the global search chord", () => {
    expect(
      matchFindChord(
        keydown({ metaKey: true, shiftKey: true, code: "KeyF", key: "F" }),
      ),
    ).toBe("search");
  });

  it("stays live inside editable fields (⌘F never types anything)", () => {
    expect(
      matchFindChord(inEditable(keydown({ metaKey: true, code: "KeyF", key: "f" }))),
    ).toBe("find");
  });

  it("returns null without the primary modifier, with Option, or for other keys", () => {
    expect(matchFindChord(keydown({ code: "KeyF", key: "f" }))).toBe(null);
    expect(
      matchFindChord(
        keydown({ metaKey: true, altKey: true, code: "KeyF", key: "ƒ" }),
      ),
    ).toBe(null);
    expect(
      matchFindChord(keydown({ metaKey: true, code: "KeyK", key: "k" })),
    ).toBe(null);
  });
});

describe("matchThreadJumpChord", () => {
  const keydown = (init: KeyboardEventInit): KeyboardEvent =>
    new KeyboardEvent("keydown", init);

  it("takes ⌘K on macOS and leaves ⌃K to the platform", () => {
    // ⌃K is delete-to-end-of-line in a macOS text field. This chord stays live
    // inside fields and calls preventDefault, so claiming the Ctrl form would
    // swallow that editing key in the composer — hence the platform gate.
    setPlatform("darwin");
    expect(
      matchThreadJumpChord(keydown({ metaKey: true, code: "KeyK", key: "k" })),
    ).toBe(true);
    expect(
      matchThreadJumpChord(keydown({ ctrlKey: true, code: "KeyK", key: "k" })),
    ).toBe(false);
  });

  it("takes Ctrl+K on Windows/Linux and ignores the Meta form", () => {
    // Ctrl+K binds nothing native there; Meta is the Windows/Super key.
    for (const platform of ["win32", "linux"]) {
      setPlatform(platform);
      expect(
        matchThreadJumpChord(keydown({ ctrlKey: true, code: "KeyK", key: "k" })),
      ).toBe(true);
      expect(
        matchThreadJumpChord(keydown({ metaKey: true, code: "KeyK", key: "k" })),
      ).toBe(false);
    }
  });

  it("accepts either modifier when the platform is unknown, so the chord never goes dead", () => {
    setPlatform(undefined);
    expect(
      matchThreadJumpChord(keydown({ metaKey: true, code: "KeyK", key: "k" })),
    ).toBe(true);
    expect(
      matchThreadJumpChord(keydown({ ctrlKey: true, code: "KeyK", key: "k" })),
    ).toBe(true);
  });

  it("stays live inside editable fields, so it works from the composer", () => {
    // The whole point of ⌘K: it opens the thread-list search no matter where
    // focus sits, unlike ⌘F which follows focus into the open thread.
    const event = keydown({ metaKey: true, code: "KeyK", key: "k" });
    Object.defineProperty(event, "target", {
      value: document.createElement("textarea"),
    });
    expect(matchThreadJumpChord(event)).toBe(true);
  });

  it("returns null without the primary modifier or with extra modifiers", () => {
    expect(matchThreadJumpChord(keydown({ code: "KeyK", key: "k" }))).toBe(false);
    expect(
      matchThreadJumpChord(
        keydown({ metaKey: true, altKey: true, code: "KeyK", key: "˚" }),
      ),
    ).toBe(false);
    expect(
      matchThreadJumpChord(
        keydown({ metaKey: true, shiftKey: true, code: "KeyK", key: "K" }),
      ),
    ).toBe(false);
    expect(
      matchThreadJumpChord(keydown({ metaKey: true, code: "KeyF", key: "f" })),
    ).toBe(false);
  });
});

describe("matchHistoryNavChord", () => {
  const keydown = (init: KeyboardEventInit): KeyboardEvent =>
    new KeyboardEvent("keydown", init);
  const inEditable = (event: KeyboardEvent): KeyboardEvent => {
    Object.defineProperty(event, "target", {
      value: document.createElement("input"),
    });
    return event;
  };

  it("classifies ⌘[ / ⌃[ as back and ⌘] / ⌃] as forward", () => {
    expect(
      matchHistoryNavChord(
        keydown({ metaKey: true, code: "BracketLeft", key: "[" }),
      ),
    ).toBe("back");
    expect(
      matchHistoryNavChord(
        keydown({ ctrlKey: true, code: "BracketRight", key: "]" }),
      ),
    ).toBe("forward");
  });

  it("matches the physical bracket key on layouts where it types another glyph", () => {
    expect(
      matchHistoryNavChord(
        keydown({ metaKey: true, code: "BracketLeft", key: "ü" }),
      ),
    ).toBe("back");
  });

  it("keeps the bracket chords live inside editable fields (like a browser)", () => {
    expect(
      matchHistoryNavChord(
        inEditable(keydown({ metaKey: true, code: "BracketLeft", key: "[" })),
      ),
    ).toBe("back");
  });

  it("classifies plain Alt+arrows as back/forward", () => {
    expect(
      matchHistoryNavChord(keydown({ altKey: true, key: "ArrowLeft" })),
    ).toBe("back");
    expect(
      matchHistoryNavChord(keydown({ altKey: true, key: "ArrowRight" })),
    ).toBe("forward");
  });

  it("suppresses Alt+arrows while editing (word-wise caret movement)", () => {
    expect(
      matchHistoryNavChord(
        inEditable(keydown({ altKey: true, key: "ArrowLeft" })),
      ),
    ).toBe(null);
  });

  it("returns null for shifted, modifier-less, or unrelated chords", () => {
    expect(
      matchHistoryNavChord(keydown({ code: "BracketLeft", key: "[" })),
    ).toBe(null);
    expect(
      matchHistoryNavChord(
        keydown({ metaKey: true, shiftKey: true, code: "BracketLeft", key: "{" }),
      ),
    ).toBe(null);
    expect(
      matchHistoryNavChord(
        keydown({ metaKey: true, altKey: true, code: "BracketLeft", key: "[" }),
      ),
    ).toBe(null);
    expect(matchHistoryNavChord(keydown({ key: "ArrowLeft" }))).toBe(null);
    expect(
      matchHistoryNavChord(keydown({ metaKey: true, code: "KeyB", key: "b" })),
    ).toBe(null);
  });
});
