import { afterEach, describe, expect, it } from "vitest";
import { getHomeDir, tildifyPath } from "../tildify-path";

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
