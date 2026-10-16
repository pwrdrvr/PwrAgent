import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { findPeerCounterpartDirectory } from "../../../lib/federation-project-match";
import { useFederationProjectStates } from "../useFederationProjectStates";

describe("useFederationProjectStates", () => {
  it("passes configured remotes to the project check and rechecks when they change", async () => {
    const fork = "github.com/fixture-fork/disktree";
    const upstream = "github.com/fixture-upstream/disktree";
    const directory = { kind: "directory" as const, label: "disktree", repositoryKey: fork };
    const peer = [{ ...directory, repositoryKey: upstream }];
    const check = vi.fn(async (_instanceId, project) => Boolean(findPeerCounterpartDirectory(project, peer)));
    const targets = [{ instanceId: "studio", label: "Studio", availability: "available" as const }];
    const { result, rerender } = renderHook(
      ({ repositoryKeys }) => useFederationProjectStates({
        directory: { ...directory, repositoryKeys }, check, targets, open: true,
      }),
      { initialProps: { repositoryKeys: [fork] } },
    );
    await waitFor(() => expect(result.current?.studio).toBe("missing"));

    act(() => rerender({ repositoryKeys: [fork, upstream] }));
    await waitFor(() => expect(result.current?.studio).toBe("present"));
    expect(check).toHaveBeenLastCalledWith("studio", { ...directory, repositoryKeys: [fork, upstream] });
  });
});
