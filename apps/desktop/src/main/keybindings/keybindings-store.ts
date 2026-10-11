/**
 * `~/.pwragent/keybindings.toml`: the operator's changed shortcuts.
 *
 * The file sits at the PwrAgent root, not in a profile, because shortcuts are
 * muscle memory and belong to the operator. Each profile runs in its own
 * process, so every process reads the file and watches it: a change saved in
 * one window's Settings rebinds the windows of every other profile.
 *
 * Only overrides are stored. An action missing from the file keeps its
 * default, so a new default reaches everyone who never changed that action,
 * and an empty list unbinds it:
 *
 *   [threads]
 *   copy_link = ["CmdOrCtrl+Alt+C"]
 *
 *   [navigation]
 *   search_threads = []
 *
 * Writes go through the diff-style TOML editor, so an operator's comments and
 * anything this build does not know survive a save from Settings.
 */
import fs from "node:fs";
import path from "node:path";
import {
  KEYBINDINGS_FILE_NAME,
  KEYBINDING_ACTIONS,
  keybindingTomlPath,
  normalizeAccelerator,
  type KeybindingActionId,
  type KeybindingOverrides,
  type KeybindingWriteRequest,
  type KeybindingsSnapshot,
} from "../../shared/keybindings";
import { getMainLogger } from "../log";
import {
  applyTomlEdits,
  parseTomlTables,
  type TomlEdit,
} from "../settings/toml-editor";

const mainLog = getMainLogger("pwragent:keybindings");

const FILE_HEADER = [
  "# PwrAgent keyboard shortcuts, shared by every profile on this machine.",
  "# Settings → Keyboard writes this file. Only changed shortcuts are stored:",
  "# an action that is not listed keeps its default, and [] unbinds it.",
  "",
].join("\n");

export function resolveKeybindingsFilePath(root: string): string {
  return path.join(root, KEYBINDINGS_FILE_NAME);
}

/**
 * Read the overrides. A missing file is no overrides. A file that cannot be
 * parsed reports the error and applies the defaults, so a typo in a hand edit
 * never leaves the app without shortcuts.
 */
export function readKeybindingsFile(filePath: string): KeybindingsSnapshot {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { overrides: {}, filePath };
    }
    return { overrides: {}, filePath, error: errorMessage(error) };
  }
  try {
    return { overrides: overridesFromSource(source, filePath), filePath };
  } catch (error) {
    return { overrides: {}, filePath, error: errorMessage(error) };
  }
}

function overridesFromSource(source: string, filePath: string): KeybindingOverrides {
  const tables = parseTomlTables(source, filePath);
  const overrides: Record<string, readonly string[]> = {};
  for (const action of KEYBINDING_ACTIONS) {
    const [table, key] = keybindingTomlPath(action.id);
    const value = tables[table]?.[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((chord) => typeof chord !== "string")) {
      mainLog.warn("keybindings: ignoring a value that is not a list of chords", {
        action: action.id,
      });
      continue;
    }
    const chords: string[] = [];
    for (const chord of value as string[]) {
      const normalized = normalizeAccelerator(chord);
      if (normalized === null) {
        mainLog.warn("keybindings: ignoring a chord that does not parse", {
          action: action.id,
          chord,
        });
        continue;
      }
      if (!chords.includes(normalized)) chords.push(normalized);
    }
    overrides[action.id] = chords;
  }
  return overrides;
}

function editsFor(request: KeybindingWriteRequest): TomlEdit[] {
  if (request.kind === "reset_all") {
    return KEYBINDING_ACTIONS.map((action) => ({
      op: "delete" as const,
      path: keybindingTomlPath(action.id),
    }));
  }
  if (request.kind === "set_many") {
    return request.changes.map((change) => setEdit(change.actionId, change.chords));
  }
  if (request.kind === "reset") {
    return [{ op: "delete", path: keybindingTomlPath(request.actionId) }];
  }
  return [setEdit(request.actionId, request.chords)];
}

function setEdit(actionId: KeybindingActionId, requested: readonly string[]): TomlEdit {
  const chords: string[] = [];
  for (const chord of requested) {
    const normalized = normalizeAccelerator(chord);
    if (normalized === null) {
      throw new Error(`"${chord}" is not a keyboard shortcut.`);
    }
    if (!chords.includes(normalized)) chords.push(normalized);
  }
  return { op: "set", path: keybindingTomlPath(actionId), value: chords };
}

function requestActionIds(request: KeybindingWriteRequest): readonly string[] {
  if (request.kind === "reset_all") return [];
  if (request.kind === "set_many") return request.changes.map((change) => change.actionId);
  return [request.actionId];
}

/** Apply one change and write the file atomically. Returns what it now holds. */
export function writeKeybindingsFile(
  filePath: string,
  request: KeybindingWriteRequest,
): KeybindingsSnapshot {
  for (const actionId of requestActionIds(request)) {
    if (!KEYBINDING_ACTIONS.some((action) => action.id === actionId)) {
      throw new Error(`Unknown keyboard shortcut action: ${actionId}`);
    }
  }
  let source: string | undefined;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // A file that does not parse is the operator's to fix: rewriting it would
  // discard whatever they were in the middle of typing.
  if (source !== undefined) {
    parseTomlTables(source, filePath);
  }
  if (source === undefined && request.kind !== "set" && request.kind !== "set_many") {
    return readKeybindingsFile(filePath);
  }
  const next = applyTomlEdits(source ?? FILE_HEADER, editsFor(request));
  if (next !== source) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, next, "utf8");
    fs.renameSync(tmpPath, filePath);
  }
  return readKeybindingsFile(filePath);
}

export type KeybindingsWatcher = { close: () => void };

/**
 * Call `onChange` when the file changes on disk, from this process or another.
 * The directory is watched rather than the file, because an atomic save
 * replaces the file and a watch on the old inode would go quiet.
 */
export function watchKeybindingsFile(
  filePath: string,
  onChange: () => void,
  options: { debounceMs?: number } = {},
): KeybindingsWatcher {
  const debounceMs = options.debounceMs ?? 120;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, { persistent: false }, (_event, changed) => {
      // Some platforms report no file name; a re-read is cheap.
      if (changed !== null && changed.toString() !== base) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onChange();
      }, debounceMs);
    });
    watcher.on("error", (error) => {
      mainLog.warn("keybindings: file watch failed", { error: errorMessage(error) });
    });
  } catch (error) {
    mainLog.warn("keybindings: could not watch the file", { error: errorMessage(error) });
  }
  return {
    close: () => {
      if (timer !== undefined) clearTimeout(timer);
      watcher?.close();
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
