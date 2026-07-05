import { describe, expect, it } from "vitest";
import electronLog from "electron-log/main.js";
import {
  compactStructuredLogData,
  isMainLogDebugCollectionEnabled,
  MAIN_LOG_MAX_SIZE_BYTES,
  resolveMainLogFileNameForProfile,
  resolveMainLogProfileName,
  setMainLogDebugCollectionEnabled,
} from "../log";

describe("main logger compact formatting", () => {
  it("suppresses the electron-log console transport during unit tests", () => {
    expect(electronLog.transports.console.level).toBe(false);
  });

  it("keeps app-log debug collection disabled unless explicitly enabled", () => {
    setMainLogDebugCollectionEnabled(false);

    expect(isMainLogDebugCollectionEnabled()).toBe(false);
    expect(electronLog.transports.file.level).toBe("info");

    setMainLogDebugCollectionEnabled(true);

    expect(isMainLogDebugCollectionEnabled()).toBe(true);
    expect(electronLog.transports.file.level).toBe("debug");

    setMainLogDebugCollectionEnabled(false);
  });

  it("keeps persistent main logs bounded to 1 MiB rotation", () => {
    expect(MAIN_LOG_MAX_SIZE_BYTES).toBe(1024 * 1024);
    expect(electronLog.transports.file.maxSize).toBe(MAIN_LOG_MAX_SIZE_BYTES);
  });

  it("omits undefined object fields from compact log output", () => {
    expect(
      compactStructuredLogData([
        "message",
        {
          backend: "codex",
          itemId: undefined,
          method: "thread/list",
          turnId: undefined,
        },
      ]),
    ).toEqual(["message backend=codex method=thread/list"]);
  });

  it("drops empty structured payloads after undefined fields are omitted", () => {
    expect(
      compactStructuredLogData(["message", { turnId: undefined }]),
    ).toEqual(["message"]);
  });

  it("keeps non-object arguments as passthrough data", () => {
    const error = new Error("boom");

    expect(compactStructuredLogData(["message", { ok: true }, error])).toEqual([
      "message ok=true",
      error,
    ]);
  });

  it("uses profile-scoped main log filenames", () => {
    expect(resolveMainLogFileNameForProfile("default")).toBe(
      "profile-default.main.log",
    );
    expect(resolveMainLogFileNameForProfile("dev")).toBe(
      "profile-dev.main.log",
    );
    expect(resolveMainLogFileNameForProfile("work")).toBe(
      "profile-work.main.log",
    );
  });

  it("derives the log profile from the startup boot decision", () => {
    expect(
      resolveMainLogProfileName({
        kind: "open",
        profileName: "dev",
        profileDir: "/profiles/dev",
        source: "env",
      }),
    ).toBe("dev");
    expect(
      resolveMainLogProfileName({
        kind: "missing-named-profile",
        requestedName: "work",
        source: "cli",
      }),
    ).toBe("work");
    expect(
      resolveMainLogProfileName({
        kind: "missing-default-profile",
        configuredName: "personal",
      }),
    ).toBe("personal");
    expect(resolveMainLogProfileName({ kind: "no-profile-configured" })).toBe(
      "bootstrap",
    );
  });
});
