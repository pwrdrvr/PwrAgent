import { describe, expect, it } from "vitest";
import {
  missingPackagedRuntimeFiles,
  normalizeAsarListing,
  requiredPackagedRuntimeFiles,
} from "./asar-entry-paths.mjs";

describe("ASAR entry paths", () => {
  it("normalizes Windows separators for platform-independent checks", () => {
    const listing = normalizeAsarListing([
      "\\out\\main\\index.js",
      "\\node_modules\\example\\src\\index.ts",
    ]);

    expect(listing).toEqual([
      "/out/main/index.js",
      "/node_modules/example/src/index.ts",
    ]);
  });

  it("preserves POSIX entry paths", () => {
    const listing = normalizeAsarListing([
      "/out/main/index.js",
    ]);

    expect(listing).toEqual([
      "/out/main/index.js",
    ]);
  });

  it("requires the Windows x64 canvas package and native binding", () => {
    const required = requiredPackagedRuntimeFiles("win32", "x64");

    expect(required).toEqual([
      {
        entry: "/node_modules/@napi-rs/canvas-win32-x64-msvc/package.json",
        unpacked: false,
      },
      {
        entry: "/node_modules/@napi-rs/canvas-win32-x64-msvc/icudtl.dat",
        unpacked: true,
      },
      {
        entry: "/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node",
        unpacked: true,
      },
      {
        entry: "/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        unpacked: true,
      },
      {
        entry: "/node_modules/node-pty/build/Release/conpty.node",
        unpacked: true,
      },
      {
        entry: "/node_modules/node-pty/build/Release/conpty_console_list.node",
        unpacked: true,
      },
    ]);
  });

  it("requires the natives beforePack stages on every target", () => {
    expect(requiredPackagedRuntimeFiles("darwin", "arm64")).toEqual([
      {
        entry: "/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        unpacked: true,
      },
      {
        entry: "/node_modules/node-pty/build/Release/pty.node",
        unpacked: true,
      },
      {
        entry: "/node_modules/node-pty/build/Release/spawn-helper",
        unpacked: true,
      },
    ]);
    expect(requiredPackagedRuntimeFiles("linux", "arm64")).toEqual([
      {
        entry: "/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        unpacked: true,
      },
      {
        entry: "/node_modules/node-pty/build/Release/pty.node",
        unpacked: true,
      },
    ]);
  });

  it("reports missing runtime files after normalizing separators", () => {
    const missing = missingPackagedRuntimeFiles([
      "\\node_modules\\@napi-rs\\canvas-win32-x64-msvc\\package.json",
      "\\node_modules\\@napi-rs\\canvas-win32-x64-msvc\\skia.win32-x64-msvc.node",
      "\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node",
      "\\node_modules\\node-pty\\build\\Release\\conpty.node",
      "\\node_modules\\node-pty\\build\\Release\\conpty_console_list.node",
    ], "win32", "x64");

    expect(missing).toEqual([
      {
        entry: "/node_modules/@napi-rs/canvas-win32-x64-msvc/icudtl.dat",
        unpacked: true,
      },
    ]);
  });

  it("does not impose Windows x64 files on another target", () => {
    expect(
      requiredPackagedRuntimeFiles("darwin", "arm64")
        .filter(({ entry }) => entry.includes("@napi-rs")),
    ).toEqual([]);
  });
});
