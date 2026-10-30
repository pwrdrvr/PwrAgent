// Gives each new on-disk test database a copy of an already-migrated one
// instead of building the schema from empty.
//
// A fresh `StateDb.open` runs all ~80 schema versions and writes about 1.3 MB.
// On a hosted `windows-latest` runner, opening and closing a fresh file took
// a mean of 183 to 299 ms across four 40-open passes. Copying a migrated file
// and opening and closing it took 11 to 12 ms. `desktop-main` makes about
// 1,100 such opens per run; their open time fell from 170 s to 24 s.
//
// The template is built by the real `StateDb.open`, once per run and profile
// name, so a copy is the same database a fresh open would have written. Each
// test still gets its own file. Only paths that do not exist yet are served:
// an upgrade test that writes an old schema first, a reopen, and `:memory:`
// all go through the real open unchanged.
//
// A test that asserts how creation itself behaves (its commit count, or the
// `auto_vacuum` mode a new file takes) opens through `openFreshStateDb` in
// `sqlite-test-utils.ts`, which bypasses this.
import fs from "node:fs";
import path from "node:path";
import { StateDb } from "../main/state/state-db";

// The real open, bound, kept on the class so `openFreshStateDb` can reach it.
// Vitest re-evaluates `state-db.ts` for each test file, so each class carries
// its own.
const ORIGINAL_OPEN = Symbol.for("pwragent.test.stateDbOriginalOpen");

type OpenFn = typeof StateDb.open;
const stateDbClass = StateDb as typeof StateDb & { [ORIGINAL_OPEN]?: OpenFn };

const templateDir = process.env.PWRAGENT_TEST_STATE_DB_TEMPLATE_DIR;

function templatePathFor(original: OpenFn, profileName: string): string {
  const name = profileName === ""
    ? "state.db"
    : `state-${Buffer.from(profileName).toString("hex")}.db`;
  const finalPath = path.join(templateDir!, name);
  if (fs.existsSync(finalPath)) return finalPath;

  // Workers race to build the first template. Each builds a private copy and
  // renames it into place; a loser keeps using its own copy.
  const buildDir = path.join(templateDir!, `build-${process.pid}-${name}`);
  const builtPath = path.join(buildDir, "state.db");
  if (!fs.existsSync(builtPath)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    const db = original(
      builtPath,
      profileName === "" ? undefined : { profileName },
    );
    // Fold the WAL into the main file so the template is one file.
    db.raw.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  }
  try {
    fs.renameSync(builtPath, finalPath);
    return finalPath;
  } catch {
    return fs.existsSync(finalPath) ? finalPath : builtPath;
  }
}

if (templateDir && !stateDbClass[ORIGINAL_OPEN]) {
  const original = StateDb.open.bind(StateDb);
  stateDbClass[ORIGINAL_OPEN] = original;
  StateDb.open = function openFromTemplate(dbPath, options) {
    if (dbPath !== ":memory:" && !fs.existsSync(dbPath)) {
      const template = templatePathFor(original, options?.profileName ?? "");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.copyFileSync(template, dbPath, fs.constants.COPYFILE_EXCL);
    }
    return original(dbPath, options);
  };
}
