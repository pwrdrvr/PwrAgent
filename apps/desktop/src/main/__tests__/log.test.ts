import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import electronLog from "electron-log/node.js";
import {
  compactStructuredLogData,
  formatAppLogLine,
  getMainLogger,
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

  it.each([
    { size: 3 * 1024 * 1024, rotates: false },
    { size: 4 * 1024 * 1024, rotates: false },
    { size: 4 * 1024 * 1024 + 1, rotates: true },
  ])("preserves the previous main log until the 4 MiB rotation threshold ($size bytes)", ({ size, rotates }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "pwragent-log-rotation-"));
    const activePath = path.join(directory, resolveMainLogFileNameForProfile("test"));
    const archivedPath = path.join(directory, "profile-test.main.old.log");
    const transport = electronLog.transports.file;
    const originalResolvePath = transport.resolvePathFn;
    try {
      writeFileSync(archivedPath, "earlier warning");
      writeFileSync(activePath, "recent warning");
      truncateSync(activePath, size);
      transport.resolvePathFn = () => activePath;

      getMainLogger("rotation-test").warn("new warning");

      const archivedWarning = rotates ? "recent warning" : "earlier warning";
      expect(readFileSync(archivedPath, "utf8").slice(0, archivedWarning.length)).toBe(archivedWarning);
      const activeLog = readFileSync(activePath, "utf8");
      expect(activeLog.startsWith("recent warning")).toBe(!rotates);
      expect(activeLog).toContain("new warning");
      expect(transport.maxSize).toBe(MAIN_LOG_MAX_SIZE_BYTES);
    } finally {
      transport.resolvePathFn = originalResolvePath;
      rmSync(directory, { recursive: true, force: true });
    }
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
    expect(compactStructuredLogData(["message", { turnId: undefined }])).toEqual([
      "message",
    ]);
  });

  it("formats errors as messages without stacks alongside structured fields", () => {
    const error = new Error("boom");

    expect(compactStructuredLogData(["message", { ok: true }, error])).toEqual([
      "message ok=true",
      "Error: boom",
    ]);
  });

  it("formats standalone and nested errors without stacks", () => {
    const error = new TypeError("Request failed");
    error.stack = "TypeError: Request failed\n    at secretInternalFrame";
    expect(compactStructuredLogData([error])).toEqual(["TypeError: Request failed"]);
    expect(compactStructuredLogData(["Request failed", { error }])).toEqual([
      'Request failed error="TypeError: Request failed"',
    ]);
    expect(compactStructuredLogData([[error], { nested: { errors: [error] } }])).toEqual([
      ["TypeError: Request failed"], { nested: { errors: ["TypeError: Request failed"] } },
    ]);
    expect(error.stack).toContain("secretInternalFrame");
  });

  it("formats raw app-log errors without stacks", () => {
    const error = new Error("Request failed");
    const line = formatAppLogLine({
      data: [error], date: new Date("2026-09-16T12:00:00Z"), level: "error",
    });
    expect(line).toContain("Error: Request failed");
    expect(line).not.toContain("\n");
  });

  it("uses profile-scoped main log filenames", () => {
    expect(resolveMainLogFileNameForProfile("default")).toBe(
      "profile-default.main.log",
    );
    expect(resolveMainLogFileNameForProfile("dev")).toBe("profile-dev.main.log");
    expect(resolveMainLogFileNameForProfile("work")).toBe("profile-work.main.log");
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
