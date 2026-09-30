import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseProcessTable, selectGraduatedProfilePids } from "../../../e2e/fixtures/detached-profile-instances";
import { DESKTOP_MAIN_ENTRY, ELECTRON_E2E_ENTRY } from "../../../e2e/fixtures/electron-app";

describe("detached E2E profile ownership", () => {
  it("selects graduated profiles launched through the release-isolation bootstrap", () => {
    // Windows CIM renders quoted argv and tab-separated PIDs. The old match
    // against out/main/index.js left this process (and launcher pipe) alive.
    const rows = parseProcessTable([
      `81001\t"C:\\Program Files\\Electron\\electron.exe" "${ELECTRON_E2E_ENTRY}" --profile "test2"`,
      `81002\t"C:\\Program Files\\Electron\\electron.exe" "${ELECTRON_E2E_ENTRY}" --profile personal`,
    ].join("\r\n"), "\t");

    expect(selectGraduatedProfilePids(rows, "test2")).toEqual([81001]);
    expect(selectGraduatedProfilePids(rows, "personal")).toEqual([81002]);
  });

  it("leaves the parent, other checkouts, other profiles, and ordinary app launches alone", () => {
    const otherEntry = path.join(path.dirname(ELECTRON_E2E_ENTRY), "other-checkout", "electron-bootstrap.mjs");
    const rows = [
      { pid: process.pid, commandLine: `electron "${ELECTRON_E2E_ENTRY}" --profile test2` },
      { pid: 81003, commandLine: `electron "${ELECTRON_E2E_ENTRY}"` },
      { pid: 81004, commandLine: `electron "${otherEntry}" --profile test2` },
      { pid: 81005, commandLine: `electron "${ELECTRON_E2E_ENTRY}" --profile test2-other` },
      { pid: 81006, commandLine: `electron "${DESKTOP_MAIN_ENTRY}" --profile test2` },
    ];

    expect(selectGraduatedProfilePids(rows, "test2")).toEqual([]);
  });
});
