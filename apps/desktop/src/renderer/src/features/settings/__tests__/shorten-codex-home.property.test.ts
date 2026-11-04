import { posix, win32 } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { shortenCodexHome } from "../shorten-codex-home";

const component = fc.array(fc.constantFrom("a", "B", "0", " ", "é"), {
  minLength: 1,
  maxLength: 10,
}).map((chars) => chars.join(""));
const segments = fc.array(component, { maxLength: 5 });

describe("shortenCodexHome regressions", () => {
  it("keeps the shrunk nested .codex counterexample unchanged", () => {
    expect(shortenCodexHome("/Users/a/projects/.codex", "/Users/a"))
      .toBe("/Users/a/projects/.codex");
  });

  it("keeps the shrunk other-user counterexample unchanged", () => {
    expect(shortenCodexHome("/Users/other/.codex", "/Users/a"))
      .toBe("/Users/other/.codex");
  });

  it.each([
    ["/Users/a/.codex/", "/Users/a/", "~/.codex/"],
    ["/Users/a/.codex/.codex", "/Users/a/.codex", "~/.codex"],
    ["/.codex/profiles/work", "/", "~/.codex/profiles/work"],
    ["C:\\Users\\a\\.codex\\", "C:\\Users\\a\\", "~\\.codex\\"],
    ["/Users/A/.codex", "/Users/a", "/Users/A/.codex"],
    ["/Users/a/.CODEX", "/Users/a", "/Users/a/.CODEX"],
    ["/Users/a/.codex", "relative", "/Users/a/.codex"],
    ["/Users/a\\folder/.codex", "/Users/a\\folder", "~/.codex"],
    ["C:\\Users\\a", "C:\\Users\\a", "C:\\Users\\a"],
  ])("formats %s with home %s as %s", (value, home, expected) => {
    expect(shortenCodexHome(value, home)).toBe(expected);
  });

  it("leaves every path unchanged when the OS home is unknown", () => {
    fc.assert(fc.property(fc.string(), (value) => {
      expect(shortenCodexHome(value, undefined)).toBe(value);
      expect(shortenCodexHome(value, "")).toBe(value);
    }));
  });
});

describe.each([
  { label: "POSIX", root: "/Users", separator: "/", windows: false },
  { label: "Windows native", root: "C:\\Users", separator: "\\", windows: true },
  { label: "Windows forward slashes", root: "C:/Users", separator: "/", windows: true },
  { label: "Windows UNC", root: "\\\\server\\share", separator: "\\", windows: true },
])("shortenCodexHome ($label)", ({ root, separator, windows }) => {
  const homeArb = component.map((user) => `${root}${separator}${user}`);
  const tailArb = segments.map((parts) => parts.length ? separator + parts.join(separator) : "");
  const inputArb = fc.tuple(homeArb, tailArb, fc.boolean()).map(([home, tail, conventional]) => ({
    home,
    value: conventional
      ? `${home}${separator}.codex${tail}`
      : `${home}${separator}projects${separator}.codex${tail}`,
  }));

  it("keeps the complete tail of a conventional Codex home after ~", () => {
    fc.assert(fc.property(homeArb, tailArb, (home, tail) => {
      const suffix = `${separator}.codex${tail}`;
      expect(shortenCodexHome(home + suffix, home)).toBe(`~${suffix}`);
    }));
  });

  it("returns paths outside the conventional root byte for byte", () => {
    fc.assert(fc.property(homeArb, tailArb, component, (home, tail, other) => {
      for (const value of [
        `${root}${separator}other${separator}.codex${tail}`,
        `${home}${separator}projects${separator}${other}${separator}.codex${tail}`,
        `${home}${separator}.codex-${other}${tail}`,
        `${home}${separator}${other}${tail}`,
      ]) {
        expect(shortenCodexHome(value, home)).toBe(value);
      }
    }));
  });

  it("names the original directory when ~ is expanded to the real home", () => {
    fc.assert(fc.property(inputArb, ({ home, value }) => {
      const display = shortenCodexHome(value, home);
      const expanded = display.startsWith("~") ? home + display.slice(1) : display;
      const path = windows ? win32 : posix;
      // Node's path implementation is independent of the display helper.
      expect(path.relative(value, expanded)).toBe("");
    }));
  });

  if (windows) {
    it("compares Windows home and .codex components without case or separator sensitivity", () => {
      fc.assert(fc.property(homeArb, tailArb, (home, tail) => {
        const suffix = `${separator}.CODEX${tail}`;
        const value = home.toUpperCase() + suffix;
        expect(shortenCodexHome(value, home.toLowerCase().replaceAll("\\", "/")))
          .toBe(`~${suffix}`);
        const expanded = home + shortenCodexHome(value, home).slice(1);
        expect(win32.relative(value, expanded)).toBe("");
      }));
    });
  }
});
