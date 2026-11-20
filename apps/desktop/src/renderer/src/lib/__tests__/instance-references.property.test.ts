import fc from "fast-check";
import { expect, it } from "vitest";
import { rankDirectoryMentionMatches } from "@pwragent/shared/directory-mention-match";
import { filterAtReferenceCandidates } from "../instance-references";

it("preserves the owner page for the confirmed query and filters stale or legacy pages locally", () => {
  fc.assert(fc.property(fc.nat(), fc.uniqueArray(fc.nat(), { minLength: 1, maxLength: 9 }), (ownerId, projectIds) => {
    const ownerHome = `/home/owner-${ownerId}`;
    const literalPath = { key: "literal", kind: "directory" as const, label: "Literal", path: "/mnt/~/projects/literal" };
    const projects = projectIds.map((id) => ({
      key: String(id), kind: "directory" as const, label: `Project ${id}`, path: `${ownerHome}/projects/${id}`, latestUpdatedAt: id,
    }));
    const query = "~/projects";
    const ownerPage = rankDirectoryMentionMatches([literalPath, ...projects], query, ownerHome);
    expect(ownerPage).toHaveLength(projects.length + 1);

    expect(filterAtReferenceCandidates(ownerPage, [], "  ~/PrOjEcTs  ", query)).toEqual(ownerPage);
    expect(filterAtReferenceCandidates(ownerPage, [], `${query}/lit`, query)).toEqual([literalPath]);
    expect(filterAtReferenceCandidates(ownerPage, [], query)).toEqual([literalPath]);
  }));
});
