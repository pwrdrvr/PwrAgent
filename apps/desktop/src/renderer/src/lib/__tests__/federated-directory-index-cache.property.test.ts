import fc from "fast-check";
import { expect, it } from "vitest";
import {
  FederatedDirectoryIndexCache,
  type FederatedDirectoryIdentity,
} from "../federated-directory-index-cache";
import { findPeerCounterpartDirectory } from "../federation-project-match";

it("serves the same destination availability from a watched index as from the owner's fresh rows", async () => {
  const source = {
    kind: "directory" as const,
    label: "Project",
    path: "/viewer/Project",
    repositoryKey: "github.com/example/project",
  };
  const checkout = (label: string): FederatedDirectoryIdentity => ({
    ...source, label, key: `directory:/owner/${label}`, path: `/owner/${label}`,
  });
  const preferred = checkout("Preferred");
  const other = checkout("Other");
  const ownerIndexes: readonly (readonly FederatedDirectoryIdentity[])[] = [
    [],
    [preferred, other],
    [{ ...preferred, checkoutPaths: [preferred.path!, "/owner/Alternate"] }, other],
  ];

  // Each owner publication advances the watch generation. Consecutive
  // checks under that generation have to agree with an uncached launch.
  await fc.assert(fc.asyncProperty(
    fc.array(fc.integer({ min: 0, max: ownerIndexes.length - 1 }), { minLength: 1, maxLength: 10 }),
    async (publications) => {
      const cache = new FederatedDirectoryIndexCache();
      for (const [generation, publication] of publications.entries()) {
        const ownerIndex = ownerIndexes[publication]!;
        const expected = Boolean(findPeerCounterpartDirectory(source, ownerIndex));
        const watch = async () => generation;
        const read = async () => ownerIndex;
        expect(await cache.hasProject("owner", source, read, watch)).toBe(expected);
        expect(await cache.hasProject("owner", source, read, watch)).toBe(expected);
      }
    },
  ));
});
