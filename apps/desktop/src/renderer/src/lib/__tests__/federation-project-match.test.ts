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
  it.each(["local", "peer"])("recognizes a fork through %s configured remotes", (side) => {
    const fork = "github.com/fixture-fork/disktree";
    const upstream = "github.com/fixture-upstream/disktree";
    const directory = { kind: "directory" as const, label: "disktree" };
    const source = {
      ...directory,
      repositoryKey: fork,
      ...(side === "local" ? { repositoryKeys: [fork, upstream] } : {}),
    };
    const peer = {
      ...directory,
      key: "peer-project",
      repositoryKey: upstream,
      ...(side === "peer" ? { repositoryKeys: [upstream, fork] } : {}),
    };

    expect(findPeerCounterpartDirectory(source, [peer])?.key).toBe("peer-project");
  });

  it("prefers the same origin over a checkout sharing another configured remote", () => {
    const fork = { ...local, repositoryKeys: [local.repositoryKey, "github.com/upstream/project-a"] };
    const peer = [
      { ...local, key: "upstream", repositoryKey: "github.com/upstream/project-a" },
      { ...local, key: "fork" },
    ];

    expect(findPeerCounterpartDirectory(fork, peer)?.key).toBe("fork");
  });

  it("matches shared remotes with different folder names and no origin", () => {
    const source = { ...local, repositoryKey: undefined, repositoryKeys: ["GitHub.com/Example-Org/Project-A"] };
    const peer = [{ kind: "directory" as const, key: "renamed", label: "Alpha", repositoryKeys: [local.repositoryKey] }];

    expect(findPeerCounterpartDirectory(source, peer)?.key).toBe("renamed");
  });

  it("rejects same names when configured remotes establish unrelated repositories", () => {
    const source = { ...local, repositoryKey: undefined, repositoryKeys: [local.repositoryKey] };
    const peer = [{ ...local, key: "other", repositoryKey: undefined, repositoryKeys: ["github.com/other/project-a"] }];

    expect(findPeerCounterpartDirectory(source, peer)).toBeUndefined();
  });

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
