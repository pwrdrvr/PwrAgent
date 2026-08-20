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
