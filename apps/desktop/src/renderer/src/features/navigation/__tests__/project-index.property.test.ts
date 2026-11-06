import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { projectTurnMarks } from "../project-index";

/*
 * The rule the project index's turn marks promise:
 *
 *   The accent scanner beside a project's name means a turn runs on this
 *   machine. A turn on a peer instance shows only the grey scanner. A
 *   federation window fronts one peer, so every turn it shows is that
 *   peer's own and none is "remote".
 *
 * The rail once lit the accent scanner from `counts.active`, which already
 * includes peer turns, so a project with only peer work read as local work
 * while its own header and the Attention tab showed grey.
 *
 * The oracle counts each kind of turn from the population itself.
 */
const population = fc.record({
  local: fc.nat({ max: 5 }),
  remote: fc.nat({ max: 5 }),
});

describe("projectTurnMarks", () => {
  it("lights the accent only for local turns and the grey only for peer turns", () => {
    fc.assert(fc.property(population, ({ local, remote }) => {
      const marks = projectTurnMarks({ active: local + remote, activeRemote: remote }, false);
      expect(marks).toEqual({ active: local > 0, activeRemote: remote > 0 });
    }));
  });

  it("treats every turn as the peer's own in a federation window", () => {
    fc.assert(fc.property(population, ({ local, remote }) => {
      const marks = projectTurnMarks({ active: local + remote, activeRemote: remote }, true);
      expect(marks).toEqual({ active: local + remote > 0, activeRemote: false });
    }));
  });

  it("reads an owner that sends no remote split as all local", () => {
    fc.assert(fc.property(fc.nat({ max: 5 }), (active) => {
      expect(projectTurnMarks({ active }, false)).toEqual({ active: active > 0, activeRemote: false });
    }));
    expect(projectTurnMarks(undefined, false)).toEqual({ active: false, activeRemote: false });
  });
});
