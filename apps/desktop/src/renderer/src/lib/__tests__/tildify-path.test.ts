import { afterEach, describe, expect, it } from "vitest";
import { expandTildePath, getHomeDir, tildifyPath } from "../tildify-path";

describe("tildifyPath", () => {
  it("collapses a home-prefixed path to ~", () => {
    expect(tildifyPath("/Users/huntharo/pwrdrvr/PwrAgnt", "/Users/huntharo")).toBe(
      "~/pwrdrvr/PwrAgnt",
    );
  });

  it("returns ~ for the home directory itself", () => {
    expect(tildifyPath("/Users/huntharo", "/Users/huntharo")).toBe("~");
  });

  it("tolerates a trailing separator on the home directory", () => {
    expect(tildifyPath("/Users/huntharo/dev", "/Users/huntharo/")).toBe("~/dev");
  });

  it("leaves paths outside home unchanged", () => {
    expect(tildifyPath("/opt/work/app", "/Users/huntharo")).toBe("/opt/work/app");
  });

  it("does not collapse a sibling whose name extends the home dir", () => {
    expect(tildifyPath("/Users/huntharo2/app", "/Users/huntharo")).toBe(
      "/Users/huntharo2/app",
    );
  });

  it("matches a back-slashed Windows home against a forward-slashed path", () => {
    expect(tildifyPath("C:/Users/foo/dev/app", "C:\\Users\\foo")).toBe("~/dev/app");
  });

  it("returns the path unchanged when the home directory is unknown", () => {
    expect(tildifyPath("/Users/huntharo/app", undefined)).toBe("/Users/huntharo/app");
    expect(tildifyPath("/Users/huntharo/app", "")).toBe("/Users/huntharo/app");
  });
});

describe("expandTildePath", () => {
  it("expands a leading ~/ to the home directory", () => {
    expect(expandTildePath("~/pwrdrvr/PwrAgnt", "/Users/huntharo")).toBe(
      "/Users/huntharo/pwrdrvr/PwrAgnt",
    );
  });

  it("expands a bare ~ to the home directory", () => {
    expect(expandTildePath("~", "/Users/huntharo")).toBe("/Users/huntharo");
  });

  it("leaves non-tilde paths unchanged", () => {
    expect(expandTildePath("/opt/work/app", "/Users/huntharo")).toBe(
      "/opt/work/app",
    );
  });

  it("leaves a tilde-user path (~foo) unchanged", () => {
    expect(expandTildePath("~foo/app", "/Users/huntharo")).toBe("~foo/app");
  });

  it("returns the path unchanged when home is unknown", () => {
    expect(expandTildePath("~/app", undefined)).toBe("~/app");
  });

  it("round-trips with tildifyPath", () => {
    const home = "/Users/huntharo";
    const absolute = "/Users/huntharo/GIPHY/search-product";
    expect(expandTildePath(tildifyPath(absolute, home), home)).toBe(absolute);
  });
});

describe("getHomeDir", () => {
  afterEach(() => {
    delete (window as unknown as { __pwragentHomeDir?: unknown }).__pwragentHomeDir;
  });

  it("reads the preload-exposed home directory", () => {
    (window as unknown as { __pwragentHomeDir?: unknown }).__pwragentHomeDir =
      "/Users/huntharo";
    expect(getHomeDir()).toBe("/Users/huntharo");
  });

  it("returns undefined when the global is missing or empty", () => {
    expect(getHomeDir()).toBeUndefined();
    (window as unknown as { __pwragentHomeDir?: unknown }).__pwragentHomeDir = "";
    expect(getHomeDir()).toBeUndefined();
  });
});
