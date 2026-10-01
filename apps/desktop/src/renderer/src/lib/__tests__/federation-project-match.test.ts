import { describe, expect, it } from "vitest";
import {
  directoryIdentityNames,
  findPeerCounterpartDirectory,
} from "../federation-project-match";

const local = {
  kind: "directory" as const,
  label: "ProjectA",
  path: "/Users/fixture-user/src/ProjectA",
  repositoryKey: "github.com/example-org/project-a",
};

describe("directoryIdentityNames", () => {
  it("folds the label and the last path segment, on either separator", () => {
    expect(directoryIdentityNames({
      kind: "directory",
      label: "Project A",
      path: "C:\\Users\\fixture\\src\\ProjectA\\",
    })).toEqual(["project a", "projecta"]);
  });
});

describe("findPeerCounterpartDirectory", () => {
  it("matches by origin even when the peer named its folder differently", () => {
    const peer = [
      { key: "w", kind: "workspace" as const, label: "Workspaces" },
      {
        key: "renamed",
        kind: "directory" as const,
        label: "ProjectAlpha",
        path: "C:\\src\\ProjectAlpha",
        repositoryKey: "GitHub.com/Example-Org/Project-A",
      },
    ];

    expect(findPeerCounterpartDirectory(local, peer)?.key).toBe("renamed");
  });

  it("never treats a same-named checkout of another origin as the project", () => {
    const peer = [{
      key: "fork",
      kind: "directory" as const,
      label: "ProjectA",
      path: "/home/fixture/ProjectA",
      repositoryKey: "github.com/someone-else/project-a",
    }];

    expect(findPeerCounterpartDirectory(local, peer)).toBeUndefined();
  });

  it("falls back to the name when the peer read no origin, preferring a label", () => {
    const peer = [
      { key: "by-path", kind: "directory" as const, label: "Scratch", path: "/srv/projecta" },
      { key: "by-label", kind: "directory" as const, label: "projecta", path: "/srv/other" },
    ];

    expect(findPeerCounterpartDirectory(local, peer)?.key).toBe("by-label");
  });

  it("skips Workspaces, unconfigured placeholders, and a project the peer lacks", () => {
    const peer = [
      { key: "w", kind: "workspace" as const, label: "ProjectA" },
      {
        key: "placeholder",
        kind: "directory" as const,
        label: "ProjectA",
        localAvailability: "unconfigured" as const,
      },
      { key: "other", kind: "directory" as const, label: "ProjectB", path: "/srv/ProjectB" },
    ];

    expect(findPeerCounterpartDirectory(local, peer)).toBeUndefined();
  });

  it("maps a Workspaces row onto the peer's own Workspaces row", () => {
    const peer = [
      { key: "p", kind: "directory" as const, label: "Workspaces" },
      { key: "peer-workspace", kind: "workspace" as const, label: "Workspaces" },
    ];

    expect(findPeerCounterpartDirectory(
      { kind: "workspace", label: "Workspaces" },
      peer,
    )?.key).toBe("peer-workspace");
  });
});
