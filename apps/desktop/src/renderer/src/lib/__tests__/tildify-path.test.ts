import { afterEach, describe, expect, it } from "vitest";
import { expandTildePath, getHomeDir, tildifyPath } from "../tildify-path";

describe("tildifyPath", () => {
  it("collapses a home-prefixed path to ~", () => {
    expect(tildifyPath("/Users/fixture-user/pwrdrvr/PwrAgnt", "/Users/fixture-user")).toBe(
      "~/pwrdrvr/PwrAgnt",
    );
  });

  it("returns ~ for the home directory itself", () => {
    expect(tildifyPath("/Users/fixture-user", "/Users/fixture-user")).toBe("~");
  });

  it("tolerates a trailing separator on the home directory", () => {
    expect(tildifyPath("/Users/fixture-user/dev", "/Users/fixture-user/")).toBe("~/dev");
  });

  it("leaves paths outside home unchanged", () => {
    expect(tildifyPath("/opt/work/app", "/Users/fixture-user")).toBe("/opt/work/app");
  });

  it("does not collapse a sibling whose name extends the home dir", () => {
    expect(tildifyPath("/Users/fixture-user2/app", "/Users/fixture-user")).toBe(
      "/Users/fixture-user2/app",
    );
  });

  it("keeps Windows home paths in their native form", () => {
    expect(tildifyPath("C:\\Users\\foo\\dev\\app", "C:\\Users\\foo")).toBe(
      "C:\\Users\\foo\\dev\\app",
    );
  });

  it.each([undefined, "", "C:\\Users\\foo", "/Users/foo"])(
    "uses native Windows separators regardless of the local home (%s)",
    (home) => {
      expect(tildifyPath("C:/Users/foo\\.codex", home)).toBe("C:\\Users\\foo\\.codex");
      expect(tildifyPath("//server/share/foo/.codex", home)).toBe("\\\\server\\share\\foo\\.codex");
    },
  );

  it("does not treat a POSIX filename backslash as a directory boundary", () => {
    expect(tildifyPath("/Users/foo\\other/file", "/Users/foo")).toBe("/Users/foo\\other/file");
  });

  it("returns the path unchanged when the home directory is unknown", () => {
    expect(tildifyPath("/Users/fixture-user/app", undefined)).toBe("/Users/fixture-user/app");
    expect(tildifyPath("/Users/fixture-user/app", "")).toBe("/Users/fixture-user/app");
  });
});

describe("expandTildePath", () => {
  it("expands a leading ~/ to the home directory", () => {
    expect(expandTildePath("~/pwrdrvr/PwrAgnt", "/Users/fixture-user")).toBe(
      "/Users/fixture-user/pwrdrvr/PwrAgnt",
    );
  });

  it("expands a bare ~ to the home directory", () => {
    expect(expandTildePath("~", "/Users/fixture-user")).toBe("/Users/fixture-user");
  });

  it("leaves non-tilde paths unchanged", () => {
    expect(expandTildePath("/opt/work/app", "/Users/fixture-user")).toBe(
      "/opt/work/app",
    );
  });

  it("leaves a tilde-user path (~foo) unchanged", () => {
    expect(expandTildePath("~foo/app", "/Users/fixture-user")).toBe("~foo/app");
  });

  it("returns the path unchanged when home is unknown", () => {
    expect(expandTildePath("~/app", undefined)).toBe("~/app");
  });

  it("round-trips with tildifyPath", () => {
    const home = "/Users/fixture-user";
    const absolute = `${home}/Projects/catalog-portal`;
    expect(expandTildePath(tildifyPath(absolute, home), home)).toBe(absolute);
  });

  it("expands Windows homes without mixed separators", () => {
    expect(expandTildePath("~/src/file.ts", "C:\\Users\\foo")).toBe("C:\\Users\\foo\\src\\file.ts");
    expect(expandTildePath("~\\src/file.ts", "//server/share/foo")).toBe("\\\\server\\share\\foo\\src\\file.ts");
  });
});

describe("getHomeDir", () => {
  afterEach(() => {
    delete (window as unknown as { __pwragentHomeDir?: unknown }).__pwragentHomeDir;
  });

  it("reads the preload-exposed home directory", () => {
    (window as unknown as { __pwragentHomeDir?: unknown }).__pwragentHomeDir =
      "/Users/fixture-user";
    expect(getHomeDir()).toBe("/Users/fixture-user");
  });

  it("returns undefined when the global is missing or empty", () => {
    expect(getHomeDir()).toBeUndefined();
    (window as unknown as { __pwragentHomeDir?: unknown }).__pwragentHomeDir = "";
    expect(getHomeDir()).toBeUndefined();
  });
});
