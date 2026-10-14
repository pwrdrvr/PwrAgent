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

  it.each(["/tmp/fixture/project", "../project", "./project", "C:\\src\\project", "file:///tmp/project"])(
    "does not use a machine-local remote as cross-machine identity: %s",
    (url) => expect(normalizeGitOriginUrl(url)).toBeUndefined(),
  );
});
