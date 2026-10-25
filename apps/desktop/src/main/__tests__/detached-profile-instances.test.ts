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

  it("selects a Linux instance whose title Chromium rewrote with switches first", () => {
    // `ps` and /proc/<pid>/cmdline both show the rewritten title, which moves
    // the bare `--profile` switch ahead of the entry and the profile name.
    const rows = parseProcessTable([
      ` 2407 /opt/electron/electron --disable-accelerated-video-decode`
        + ` --disable-accelerated-video-encode --profile ${ELECTRON_E2E_ENTRY} personal`,
      ` 2408 /opt/electron/electron --profile ${ELECTRON_E2E_ENTRY} personal-two`,
    ].join("\n"), " ");

    expect(selectGraduatedProfilePids(rows, "personal")).toEqual([2407]);
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
