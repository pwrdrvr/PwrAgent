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
    ]);
  });

  it("reports missing runtime files after normalizing separators", () => {
    const missing = missingPackagedRuntimeFiles([
      "\\node_modules\\@napi-rs\\canvas-win32-x64-msvc\\package.json",
      "\\node_modules\\@napi-rs\\canvas-win32-x64-msvc\\skia.win32-x64-msvc.node",
    ], "win32", "x64");

    expect(missing).toEqual([
      {
        entry: "/node_modules/@napi-rs/canvas-win32-x64-msvc/icudtl.dat",
        unpacked: true,
      },
    ]);
  });

  it("does not impose Windows x64 files on another target", () => {
    expect(requiredPackagedRuntimeFiles("darwin", "arm64")).toEqual([]);
  });
});
