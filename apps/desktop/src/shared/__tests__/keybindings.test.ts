import { describe, expect, it } from "vitest";
import {
  KEYBINDING_ACTIONS,
  chordFromEvent,
  chordIdentity,
  eventMatchesAction,
  findActionUsingChord,
  formatAriaKeyShortcut,
  formatChordLabel,
  formatModifiersLabel,
  isActionChanged,
  isTextEditingChord,
  matchesChord,
  normalizeAccelerator,
  parseChord,
  refuseChord,
  resolveKeybindings,
  type KeyEventLike,
} from "../keybindings";

function keyEvent(overrides: Partial<KeyEventLike>): KeyEventLike {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("parseChord", () => {
  it("reads modifiers and canonical key names", () => {
    expect(parseChord("CmdOrCtrl+Shift+Backspace")).toEqual({
      primary: true,
      meta: false,
      ctrl: false,
      alt: false,
      shift: true,
      key: "Backspace",
    });
    expect(parseChord("Option+Command+r")?.key).toBe("R");
    expect(parseChord("F2")?.key).toBe("F2");
    expect(parseChord("CmdOrCtrl++")?.key).toBe("Plus");
  });

  it("rejects unknown keys and modifiers", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord("Hyper+K")).toBeNull();
    expect(parseChord("CmdOrCtrl+Banana")).toBeNull();
    expect(parseChord("Shift+")).toBeNull();
  });

  it("normalizes spellings to one order", () => {
    expect(normalizeAccelerator("Shift+Alt+CommandOrControl+p")).toBe("CmdOrCtrl+Alt+Shift+P");
  });
});

describe("chordIdentity", () => {
  it("collides CmdOrCtrl with the platform's own modifier", () => {
    expect(chordIdentity("CmdOrCtrl+K", "darwin")).toBe(chordIdentity("Command+K", "darwin"));
    expect(chordIdentity("CmdOrCtrl+K", "darwin")).not.toBe(chordIdentity("Ctrl+K", "darwin"));
    expect(chordIdentity("CmdOrCtrl+K", "win32")).toBe(chordIdentity("Ctrl+K", "win32"));
  });
});

describe("matchesChord", () => {
  it("falls back to the physical key, so Option-compose cannot hide a letter", () => {
    const event = keyEvent({ key: "®", code: "KeyR", metaKey: true, altKey: true });
    expect(matchesChord(event, "CmdOrCtrl+Alt+R", "darwin")).toBe(true);
    const dead = keyEvent({ key: "Dead", code: "KeyE", metaKey: true, altKey: true });
    expect(matchesChord(dead, "CmdOrCtrl+Alt+E", "darwin")).toBe(true);
  });

  it("matches the letter printed on the key, as the menu bar does", () => {
    // AZERTY: the key printed A sits where QWERTY has Q.
    const azertyA = keyEvent({ key: "a", code: "KeyQ", metaKey: true });
    expect(matchesChord(azertyA, "CmdOrCtrl+A", "darwin")).toBe(true);
    expect(matchesChord(azertyA, "CmdOrCtrl+Q", "darwin")).toBe(false);
    // A non-Latin layout has no Latin letter to print; the position decides.
    const cyrillic = keyEvent({ key: "ф", code: "KeyA", metaKey: true });
    expect(matchesChord(cyrillic, "CmdOrCtrl+A", "darwin")).toBe(true);
  });

  it("keeps the key under a shifted symbol, and a symbol with its own key", () => {
    const bang = keyEvent({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
    expect(matchesChord(bang, "CmdOrCtrl+Shift+1", "linux")).toBe(true);
    // German layouts print + on an unshifted key.
    const plus = keyEvent({ key: "+", code: "BracketRight", ctrlKey: true });
    expect(matchesChord(plus, "CmdOrCtrl+Plus", "linux")).toBe(true);
  });

  it("resolves CmdOrCtrl per platform", () => {
    const ctrlK = keyEvent({ key: "k", code: "KeyK", ctrlKey: true });
    expect(matchesChord(ctrlK, "CmdOrCtrl+K", "darwin")).toBe(false);
    expect(matchesChord(ctrlK, "CmdOrCtrl+K", "linux")).toBe(true);
  });

  it("accepts either primary key when the platform is unknown", () => {
    expect(matchesChord(keyEvent({ key: "b", code: "KeyB", metaKey: true }), "CmdOrCtrl+B", undefined)).toBe(true);
    expect(matchesChord(keyEvent({ key: "b", code: "KeyB", ctrlKey: true }), "CmdOrCtrl+B", undefined)).toBe(true);
    expect(matchesChord(
      keyEvent({ key: "b", code: "KeyB", ctrlKey: true, metaKey: true }),
      "CmdOrCtrl+B",
      undefined,
    )).toBe(false);
  });

  it("requires Shift and Alt to match exactly", () => {
    const shifted = keyEvent({ key: "P", code: "KeyP", metaKey: true, shiftKey: true });
    expect(matchesChord(shifted, "CmdOrCtrl+P", "darwin")).toBe(false);
    expect(matchesChord(shifted, "CmdOrCtrl+Shift+P", "darwin")).toBe(true);
  });

  it("falls back to event.key when code is missing", () => {
    expect(matchesChord(keyEvent({ key: "ArrowUp", metaKey: true, shiftKey: true }), "CmdOrCtrl+Shift+Up", "darwin")).toBe(true);
    expect(matchesChord(keyEvent({ key: "[", metaKey: true }), "CmdOrCtrl+[", "darwin")).toBe(true);
  });
});

describe("chordFromEvent", () => {
  it("records in the platform's storage form", () => {
    const event = keyEvent({ key: "R", code: "KeyR", metaKey: true, altKey: true });
    expect(chordFromEvent(event, "darwin")).toBe("CmdOrCtrl+Alt+R");
    expect(chordFromEvent(keyEvent({ key: "p", code: "KeyP", ctrlKey: true, shiftKey: true }), "win32"))
      .toBe("CmdOrCtrl+Shift+P");
    expect(chordFromEvent(keyEvent({ key: "a", code: "KeyA", ctrlKey: true }), "darwin")).toBe("Ctrl+A");
  });

  it("ignores a lone modifier", () => {
    expect(chordFromEvent(keyEvent({ key: "Shift", code: "ShiftLeft", shiftKey: true }), "darwin")).toBeNull();
  });
});

describe("resolveKeybindings", () => {
  it("uses platform defaults and lets an override replace or unbind them", () => {
    const mac = resolveKeybindings({}, "darwin");
    expect(mac.get("threads.rename")).toEqual(["CmdOrCtrl+Alt+R", "F2"]);
    expect(mac.get("threads.toggle_unread")).toEqual(["CmdOrCtrl+Shift+U"]);
    const linux = resolveKeybindings({}, "linux");
    expect(linux.get("threads.rename")).toEqual(["F2"]);
    expect(linux.get("threads.toggle_unread")).toEqual([]);

    const overridden = resolveKeybindings(
      { "threads.archive": [], "threads.copy_link": ["CmdOrCtrl+Alt+C"] },
      "darwin",
    );
    expect(overridden.get("threads.archive")).toEqual([]);
    expect(overridden.get("threads.copy_link")).toEqual(["CmdOrCtrl+Alt+C"]);
  });

  it("ships no two actions on one chord", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      const seen = new Map<string, string>();
      for (const [actionId, chords] of resolveKeybindings({}, platform)) {
        for (const chord of chords) {
          const identity = chordIdentity(chord, platform);
          expect(identity, `${platform} ${chord}`).not.toBeNull();
          expect(seen.get(identity!), `${platform} ${chord}`).toBeUndefined();
          seen.set(identity!, actionId);
        }
      }
    }
  });

  it("ships no default the recorder would refuse", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      for (const [actionId, chords] of resolveKeybindings({}, platform)) {
        for (const chord of chords) {
          expect(refuseChord(chord, platform), `${platform} ${actionId} ${chord}`).toBeNull();
        }
      }
    }
  });
});

describe("isActionChanged", () => {
  const rename = KEYBINDING_ACTIONS.find((action) => action.id === "threads.rename")!;

  it("treats an override equal to the defaults as unchanged", () => {
    expect(isActionChanged(rename, {}, "darwin")).toBe(false);
    expect(isActionChanged(rename, { "threads.rename": ["Command+Option+R", "F2"] }, "darwin")).toBe(false);
    expect(isActionChanged(rename, { "threads.rename": ["F2"] }, "darwin")).toBe(true);
  });
});

describe("findActionUsingChord", () => {
  it("names the action a chord already runs", () => {
    const bindings = resolveKeybindings({}, "darwin");
    expect(findActionUsingChord(bindings, "Command+Shift+F", "darwin")).toBe("navigation.search_threads");
    expect(findActionUsingChord(bindings, "CmdOrCtrl+Shift+F", "darwin", "navigation.search_threads")).toBeNull();
    expect(findActionUsingChord(bindings, "CmdOrCtrl+Alt+Shift+Z", "darwin")).toBeNull();
  });
});

describe("eventMatchesAction", () => {
  const mac = resolveKeybindings({}, "darwin");

  it("keeps a text-editing chord out of fields but fires it elsewhere", () => {
    const optionLeft = keyEvent({ key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    expect(eventMatchesAction(optionLeft, "navigation.back", mac, "darwin", false)).toBe(true);
    expect(eventMatchesAction(optionLeft, "navigation.back", mac, "darwin", true)).toBe(false);
    const bracket = keyEvent({ key: "[", code: "BracketLeft", metaKey: true });
    expect(eventMatchesAction(bracket, "navigation.back", mac, "darwin", true)).toBe(true);
  });

  it("keeps an action that does not fire in fields out of them", () => {
    const cmdB = keyEvent({ key: "b", code: "KeyB", metaKey: true });
    expect(eventMatchesAction(cmdB, "layout.toggle_sidebar", mac, "darwin", false)).toBe(true);
    expect(eventMatchesAction(cmdB, "layout.toggle_sidebar", mac, "darwin", true)).toBe(false);
  });

  it("fires archive from the composer", () => {
    const archive = keyEvent({ key: "Backspace", code: "Backspace", metaKey: true, shiftKey: true });
    expect(eventMatchesAction(archive, "threads.archive", mac, "darwin", true)).toBe(true);
  });
});

describe("isTextEditingChord", () => {
  it("knows the macOS editing keys", () => {
    expect(isTextEditingChord("CmdOrCtrl+Backspace", "darwin")).toBe(true);
    expect(isTextEditingChord("CmdOrCtrl+Shift+Backspace", "darwin")).toBe(false);
    expect(isTextEditingChord("Alt+Left", "darwin")).toBe(true);
    expect(isTextEditingChord("CmdOrCtrl+Shift+Up", "darwin")).toBe(true);
    expect(isTextEditingChord("Ctrl+K", "darwin")).toBe(true);
    expect(isTextEditingChord("CmdOrCtrl+K", "darwin")).toBe(false);
    expect(isTextEditingChord("CmdOrCtrl+Shift+Z", "darwin")).toBe(true);
  });

  it("knows the Windows and Linux editing keys", () => {
    expect(isTextEditingChord("CmdOrCtrl+Backspace", "win32")).toBe(true);
    expect(isTextEditingChord("CmdOrCtrl+Shift+Backspace", "win32")).toBe(false);
    expect(isTextEditingChord("CmdOrCtrl+Left", "linux")).toBe(true);
    expect(isTextEditingChord("CmdOrCtrl+K", "linux")).toBe(false);
  });
});

describe("refuseChord", () => {
  it("needs a modifier unless the key is a function key", () => {
    expect(refuseChord("E", "darwin")).toEqual({ kind: "needs_modifier" });
    expect(refuseChord("Shift+E", "darwin")).toEqual({ kind: "needs_modifier" });
    expect(refuseChord("F2", "darwin")).toBeNull();
  });

  it("refuses chords the system and the app menu keep", () => {
    expect(refuseChord("CmdOrCtrl+H", "darwin")).toEqual({
      kind: "reserved",
      reason: "macOS uses ⌘H to hide the app.",
    });
    expect(refuseChord("CmdOrCtrl+Q", "darwin")?.kind).toBe("reserved");
    expect(refuseChord("CmdOrCtrl+R", "darwin")?.kind).toBe("reserved");
    expect(refuseChord("CmdOrCtrl+3", "win32")).toEqual({
      kind: "reserved",
      reason: "Profiles use Ctrl+1 to Ctrl+9.",
    });
    expect(refuseChord("Alt+F4", "win32")?.kind).toBe("reserved");
    expect(refuseChord("Super+K", "linux")?.kind).toBe("reserved");
    expect(refuseChord("CmdOrCtrl+Alt+C", "darwin")).toBeNull();
  });
});

describe("formatChordLabel", () => {
  it("draws macOS glyphs in Apple's modifier order", () => {
    expect(formatChordLabel("CmdOrCtrl+Alt+R", "darwin")).toBe("⌥⌘R");
    expect(formatChordLabel("CmdOrCtrl+Shift+Backspace", "darwin")).toBe("⇧⌘⌫");
    expect(formatChordLabel("CmdOrCtrl+Shift+Up", "darwin")).toBe("⇧⌘↑");
    expect(formatChordLabel("Ctrl+Alt+K", "darwin")).toBe("⌃⌥K");
  });

  it("spells modifiers out elsewhere", () => {
    expect(formatChordLabel("CmdOrCtrl+Shift+P", "win32")).toBe("Ctrl+Shift+P");
    expect(formatChordLabel("CmdOrCtrl+Shift+Up", "linux")).toBe("Ctrl+Shift+↑");
    expect(formatChordLabel("F2", "linux")).toBe("F2");
    // The Windows/Super key leads, as Microsoft and PwrSnap write it.
    expect(formatChordLabel("Super+Shift+K", "win32")).toBe("Win+Shift+K");
    expect(formatChordLabel("CmdOrCtrl+Super+K", "linux")).toBe("Super+Ctrl+K");
    expect(formatModifiersLabel(
      { key: "Shift", metaKey: true, ctrlKey: true, altKey: false, shiftKey: true },
      "win32",
    )).toBe("Win+Ctrl+Shift");
  });
});

describe("formatAriaKeyShortcut", () => {
  it("writes the ARIA token for the platform", () => {
    expect(formatAriaKeyShortcut("CmdOrCtrl+Shift+Up", "darwin")).toBe("Meta+Shift+ArrowUp");
    expect(formatAriaKeyShortcut("CmdOrCtrl+Shift+Up", "linux")).toBe("Control+Shift+ArrowUp");
  });
});
