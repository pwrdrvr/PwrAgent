import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPwrSuiteRelay, pwrSuiteRelayPath, type PwrSuiteRelayApp } from "../mcp-connections/pwrsuite-relay";
import { pwrSuiteInstall, removePwrSuiteInstalls } from "./helpers/pwrsuite-install-fixture";

const links: string[] = [];

afterEach(() => {
  for (const directory of links.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  removePwrSuiteInstalls();
});

function linkTo(target: string, name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-relay-link-"));
  links.push(directory);
  const link = path.join(directory, name);
  fs.symlinkSync(target, link);
  return link;
}

// A Linux package puts the app under /opt and links it from /usr/bin. The
// relay sits in the install's own `resources/`, never beside the link.
describe.skipIf(process.platform === "win32")("PwrSuite relay lookup", () => {
  it.each<PwrSuiteRelayApp>(["pwrsnap", "pwrgit"])(
    "finds %s's relay inside the install a link points at",
    (app) => {
      const installed = pwrSuiteInstall(app);
      const link = linkTo(installed, app);
      // Oracle: the relay beside the real install, whatever path names it.
      const expected = pwrSuiteRelayPath(app, fs.realpathSync(installed));
      expect(findPwrSuiteRelay(app, [link])).toBe(expected);
      expect(findPwrSuiteRelay(app, [installed])).toBe(expected);
    },
  );

  it("reports no relay for a link to an install that predates it", () => {
    const link = linkTo(pwrSuiteInstall("pwrsnap", { relay: false }), "pwrsnap");
    expect(findPwrSuiteRelay("pwrsnap", [link])).toBeUndefined();
  });
});
