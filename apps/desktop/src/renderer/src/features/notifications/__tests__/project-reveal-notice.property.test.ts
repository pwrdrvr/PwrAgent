import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { OpenPathResponse } from "@pwragent/shared";
import { resolveProjectRevealNotice } from "../project-reveal-notice";

const project = fc.record({
  label: fc.stringMatching(/^[A-Za-z0-9 ._-]{1,16}$/),
  path: fc.stringMatching(/^\/[A-Za-z0-9/._-]{1,40}$/),
});

const response: fc.Arbitrary<OpenPathResponse> = fc.record(
  {
    opened: fc.boolean(),
    error: fc.string(),
    missing: fc.constant(true as const),
  },
  { requiredKeys: ["opened"] },
);

const channel = fc.stringMatching(/^[a-z:-]{1,20}$/);
const reason = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 .]{0,30}$/);
/** What `ipcRenderer.invoke` rejects with when the main-process handler throws. */
const ipcRejection = fc.tuple(channel, reason).map(([name, text]) =>
  new Error(`Error invoking remote method '${name}': Error: ${text}`));
const thrown = fc.oneof(
  ipcRejection,
  reason.map((text) => new Error(text)),
  reason,
);

describe("resolveProjectRevealNotice", () => {
  it("is silent exactly when the folder opened", () => {
    fc.assert(fc.property(project, response, (target, result) => {
      const notice = resolveProjectRevealNotice(target, { response: result });
      expect(notice === undefined).toBe(result.opened);
    }));
  });

  it("names the project and says the folder is gone when it is missing", () => {
    fc.assert(fc.property(project, response, (target, result) => {
      fc.pre(!result.opened && result.missing === true);
      const notice = resolveProjectRevealNotice(target, { response: result });
      expect(notice?.message).toContain(`${target.label}'s folder was not found`);
    }));
  });

  it("reports every rejected reveal with a non-empty reason and no Electron IPC wrapper", () => {
    fc.assert(fc.property(project, thrown, (target, error) => {
      const notice = resolveProjectRevealNotice(target, { error });
      expect(notice).toBeDefined();
      expect(notice?.message.trim()).not.toBe("");
      expect(notice?.message).not.toMatch(/Error invoking remote method/);
    }));
  });

  it("keeps the IPC rejection's own reason", () => {
    expect(resolveProjectRevealNotice(
      { label: "PwrAgent", path: "/repo" },
      { error: new Error("Error invoking remote method 'shell:reveal-path': Error: EACCES") },
    )?.message).toBe("EACCES");
  });
});
