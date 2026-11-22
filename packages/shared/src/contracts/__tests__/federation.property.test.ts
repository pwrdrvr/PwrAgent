import fc from "fast-check";
import { expect, it } from "vitest";
import {
  formatFederationPeerDisplayLabel,
  formatFederationPeerDisplayLabelParts,
  formatFederationPeerShortDisplayLabel,
} from "../federation";

it("displays named profiles and leaves the default profile implicit in every label form", () => {
  fc.assert(fc.property(
    fc.stringMatching(/^Host[A-Z]{0,8}$/),
    fc.option(fc.stringMatching(/^Lab[A-Z]{0,8}$/), { nil: undefined }),
    fc.constantFrom(undefined, "default", "dev", "work"),
    (label, shortLabel, profileName) => {
      const peer = { label, shortLabel, profileName };
      const shownProfile = profileName === "default" ? undefined : profileName;
      const suffix = shownProfile ? ` / ${shownProfile}` : "";

      expect(formatFederationPeerDisplayLabelParts(peer)).toEqual({
        label,
        ...(shortLabel ? { shortLabel } : {}),
        ...(shownProfile ? { profileName: shownProfile } : {}),
      });
      expect(formatFederationPeerDisplayLabel(peer)).toBe(`${label}${suffix}`);
      expect(formatFederationPeerShortDisplayLabel(peer)).toBe(`${shortLabel ?? label}${suffix}`);
    },
  ));
});
