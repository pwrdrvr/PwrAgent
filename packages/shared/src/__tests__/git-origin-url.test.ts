import { describe, expect, it } from "vitest";
import { normalizeGitOriginUrl } from "../directory-navigation";

describe("normalizeGitOriginUrl", () => {
  it.each([
    "git@github.com:Fixture/Project.git",
    "https://github.com/Fixture/Project.git",
    "ssh://git@github.com/Fixture/Project.git",
    "github.com/Fixture/Project.git",
  ])("normalizes %s without credentials or transport", (url) => {
    expect(normalizeGitOriginUrl(url)).toBe("github.com/fixture/project");
  });

  it.each([
    ["/tmp/Fixture/Project.git", "tmp/fixture/project"],
    ["../Project.git", "../project"],
    ["./Project.git", "./project"],
    ["C:\\src\\Project.git", "c:\\src\\project"],
    ["file:///tmp/Project.git", "tmp/project"],
  ])(
    "preserves the local remote identity used by Git handoffs: %s",
    (url, identity) => expect(normalizeGitOriginUrl(url)).toBe(identity),
  );
});
