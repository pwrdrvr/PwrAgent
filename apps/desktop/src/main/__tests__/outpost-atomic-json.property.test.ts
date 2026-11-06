import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { beforeAll, expect, it } from "vitest";

let atomicJson: (file: string, value: unknown) => void;

beforeAll(async () => {
  const url = pathToFileURL(path.join(process.cwd(), "packages/pwragent/src/store.js")).href;
  ({ atomicJson } = await import(/* @vite-ignore */ url));
});

/** Model the kernel boundary; keep the real file write, rename and cleanup. */
function withFilesystemModel(platform: string, failFileSync: boolean, operation: (events: string[]) => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalSync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  const events: string[] = [];
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  fs.fsyncSync = (fd) => {
    const directory = fs.fstatSync(fd).isDirectory();
    events.push(directory ? "directory-sync" : "file-sync");
    if (directory && platform === "win32") throw Object.assign(new Error("directory sync unsupported"), { code: "EPERM" });
    if (!directory && failFileSync) throw Object.assign(new Error("file sync failed"), { code: "EPERM" });
  };
  fs.renameSync = (from, to) => { events.push("rename"); originalRename(from, to); };
  syncBuiltinESMExports();
  try { operation(events); }
  finally {
    fs.fsyncSync = originalSync;
    fs.renameSync = originalRename;
    Object.defineProperty(process, "platform", descriptor);
    syncBuiltinESMExports();
  }
}

function withRegistry(operation: (file: string, directory: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-json-"));
  try { operation(path.join(directory, "registry.json"), directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

it("publishes generated JSON on Windows after syncing its file, without requesting unsupported directory sync", () => {
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    withRegistry((file, directory) => withFilesystemModel("win32", false, (events) => {
      atomicJson(file, value);
      expect(events).toEqual(["file-sync", "rename"]);
      expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(value) + "\n");
      expect(fs.readdirSync(directory)).toEqual(["registry.json"]);
    }));
  }), { numRuns: 30 });
});

it("saves an empty registry array when Windows directory sync is unavailable", () => {
  withRegistry((file) => withFilesystemModel("win32", false, () => {
    atomicJson(file, []);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([]);
  }));
});

it("keeps file-sync, rename, directory-sync ordering on POSIX", () => {
  fc.assert(fc.property(fc.constantFrom("darwin", "linux"), fc.jsonValue(), (platform, value) => {
    withRegistry((file, directory) => withFilesystemModel(platform, false, (events) => {
      atomicJson(file, value);
      expect(events).toEqual(["file-sync", "rename", "directory-sync"]);
      expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(value) + "\n");
      expect(fs.readdirSync(directory)).toEqual(["registry.json"]);
    }));
  }), { numRuns: 30 });
});

it("never suppresses file-sync failures or replaces existing data on any platform", () => {
  fc.assert(fc.property(fc.constantFrom("win32", "darwin", "linux"), fc.jsonValue(), (platform, value) => {
    withRegistry((file, directory) => {
      fs.writeFileSync(file, "original\n");
      withFilesystemModel(platform, true, (events) => {
        expect(() => atomicJson(file, value)).toThrow("file sync failed");
        expect(events).toEqual(["file-sync"]);
        expect(fs.readFileSync(file, "utf8")).toBe("original\n");
        expect(fs.readdirSync(directory)).toEqual(["registry.json"]);
      });
    });
  }), { numRuns: 30 });
});
