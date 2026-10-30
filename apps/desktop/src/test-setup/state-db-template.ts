// Gives each new test database a copy of an already-migrated one instead of
// building the schema from empty.
//
// A fresh `StateDb.open` runs all ~80 schema versions and writes about 1.3 MB.
// On a hosted `windows-latest` runner, opening and closing a fresh file took
// a mean of 183 to 299 ms across four 40-open passes. Copying a migrated file
// and opening and closing it took 11 to 12 ms. `desktop-main` makes about
// 1,100 such opens per run; their open time fell from 170 s to 24 s.
//
// `:memory:` opens get the same treatment from a serialized image. A fresh
// in-memory open is all DDL CPU, and `desktop-main` makes ~1,400 per run. On a
// `windows-latest` runner, opening and closing one took a mean of 47 to 51 ms
// across three 60-open passes; over a migrated image it took 7 ms. The image
// is handed to better-sqlite3's constructor (`new Database(buffer)`), so
// `StateDb.open` still runs every pragma, the version checks and the converge
// steps against it; only the build from empty is skipped.
//
// Each template is built by the real `StateDb.open`, once per run, kind and
// profile name, so a copy is the same database a fresh open would have
// written. Each test still gets its own database. Only new files and
// `:memory:` are served: an upgrade test that writes an old schema first and
// a reopen go through the real open unchanged.
//
// A test that asserts how creation itself behaves (its commit count, or the
// `auto_vacuum` mode a new file takes) opens through `openFreshStateDb` in
// `sqlite-test-utils.ts`, which bypasses this.
//
// The patches are applied in module factories, not by importing `state-db.ts`
// here. A setup file runs for every test file, and most never open a
// database; importing it eagerly raised Vitest's setup time from 1% to 8-11%
// of a Windows lane.
import fs from "node:fs";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { vi } from "vitest";
import type { StateDb } from "../main/state/state-db";

// The real open, bound, kept on the class so `openFreshStateDb` can reach it.
const ORIGINAL_OPEN = Symbol.for("pwragent.test.stateDbOriginalOpen");

type OpenFn = typeof StateDb.open;
type StateDbClass = typeof StateDb & { [ORIGINAL_OPEN]?: OpenFn };

const templateDir = process.env.PWRAGENT_TEST_STATE_DB_TEMPLATE_DIR;

// Publishes a template under `dir` once per run. Workers race to build the
// first one; each builds a private copy and renames it into place, and a
// loser keeps using its own copy.
function sharedTemplate(
  dir: string,
  name: string,
  build: (targetPath: string) => void,
): string {
  const finalPath = path.join(dir, name);
  if (fs.existsSync(finalPath)) return finalPath;

  const buildDir = path.join(dir, `build-${process.pid}-${name}`);
  const builtPath = path.join(buildDir, "state.db");
  if (!fs.existsSync(builtPath)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(buildDir, { recursive: true });
    build(builtPath);
  }
  try {
    fs.renameSync(builtPath, finalPath);
    return finalPath;
  } catch {
    return fs.existsSync(finalPath) ? finalPath : builtPath;
  }
}

function templateName(kind: "file" | "memory", profileName: string): string {
  const suffix = profileName === ""
    ? ""
    : `-${Buffer.from(profileName).toString("hex")}`;
  return kind === "file" ? `state${suffix}.db` : `memory${suffix}.db`;
}

function profileOptions(profileName: string): { profileName: string } | undefined {
  return profileName === "" ? undefined : { profileName };
}

function fileTemplatePath(dir: string, original: OpenFn, profileName: string): string {
  return sharedTemplate(dir, templateName("file", profileName), (target) => {
    const db = original(target, profileOptions(profileName));
    // Fold the WAL into the main file so the template is one file.
    db.raw.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  });
}

// Read once per test file; Vitest re-evaluates this module for each.
const memoryImages = new Map<string, Buffer>();

function memoryImage(dir: string, original: OpenFn, profileName: string): Buffer {
  const cached = memoryImages.get(profileName);
  if (cached) return cached;
  const imagePath = sharedTemplate(
    dir,
    templateName("memory", profileName),
    (target) => {
      const db = original(":memory:", profileOptions(profileName));
      fs.writeFileSync(target, db.raw.serialize());
      db.close();
    },
  );
  const image = fs.readFileSync(imagePath);
  memoryImages.set(profileName, image);
  return image;
}

// The image the next `new Database(":memory:")` opens. Set only for the
// duration of one `StateDb.open(":memory:")` call, so a test that builds a raw
// in-memory database itself still gets an empty one.
let pendingMemoryImage: Buffer | undefined;

function serveNewFilesFromTemplate(stateDb: StateDbClass, dir: string): void {
  if (stateDb[ORIGINAL_OPEN]) return;
  const original = stateDb.open.bind(stateDb);
  stateDb[ORIGINAL_OPEN] = original;
  stateDb.open = function openFromTemplate(dbPath, options) {
    const profileName = options?.profileName ?? "";
    if (dbPath === ":memory:") {
      pendingMemoryImage = memoryImage(dir, original, profileName);
      try {
        return original(dbPath, options);
      } finally {
        pendingMemoryImage = undefined;
      }
    }
    // `""` is SQLite's anonymous temporary database; it is left alone.
    if (dbPath !== "" && !fs.existsSync(dbPath)) {
      const template = fileTemplatePath(dir, original, profileName);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.copyFileSync(template, dbPath, fs.constants.COPYFILE_EXCL);
    }
    return original(dbPath, options);
  };
}

// Vitest accepts `vi.mock` only at the top level and hoists it, so the
// factory checks the environment itself. It runs once per test file, and only
// in a file whose imports reach `state-db.ts`.
vi.mock(import("../main/state/state-db"), async (importOriginal) => {
  const actual = await importOriginal();
  if (templateDir) serveNewFilesFromTemplate(actual.StateDb, templateDir);
  return actual;
});

// `StateDb.open` constructs its connection itself, so the image reaches it
// through the constructor. A subclass keeps `instanceof`, statics, and
// prototype patches working for every other caller.
vi.mock(import("better-sqlite3"), async (importOriginal) => {
  const actual = await importOriginal();
  const Database = actual.default;
  class TemplateDatabase extends Database {
    constructor(filename?: string | Buffer, options?: BetterSqlite3.Options) {
      const image = filename === ":memory:" ? pendingMemoryImage : undefined;
      pendingMemoryImage = undefined;
      super(image ?? filename, options);
    }
  }
  return { ...actual, default: TemplateDatabase as typeof Database };
});
