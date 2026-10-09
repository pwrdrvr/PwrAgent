import { ipcMain } from "electron";
import {
  KEYBINDINGS_CHANGED_CHANNEL,
  KEYBINDINGS_READ_CHANNEL,
  KEYBINDINGS_WRITE_CHANNEL,
} from "../../shared/ipc";
import {
  isKeybindingActionId,
  type KeybindingWriteRequest,
  type KeybindingsSnapshot,
} from "../../shared/keybindings";
import {
  readKeybindingsFile,
  resolveKeybindingsFilePath,
  watchKeybindingsFile,
  writeKeybindingsFile,
  type KeybindingsWatcher,
} from "../keybindings/keybindings-store";
import { resolvePwragentRoot } from "../profile";
import { subscribersForChannel } from "../window-channels";

type KeybindingsListener = (snapshot: KeybindingsSnapshot) => void;

let filePath: string | undefined;
let snapshot: KeybindingsSnapshot | undefined;
let watcher: KeybindingsWatcher | undefined;
const listeners = new Set<KeybindingsListener>();

function currentFilePath(): string {
  filePath ??= resolveKeybindingsFilePath(resolvePwragentRoot());
  return filePath;
}

/** The overrides this process last read. Reads the file on first use. */
export function getKeybindingsSnapshot(): KeybindingsSnapshot {
  snapshot ??= readKeybindingsFile(currentFilePath());
  return snapshot;
}

/** Called after every change, so the application menu can rebuild. */
export function onKeybindingsChanged(listener: KeybindingsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function sameSnapshot(left: KeybindingsSnapshot | undefined, right: KeybindingsSnapshot): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function publish(next: KeybindingsSnapshot): void {
  if (sameSnapshot(snapshot, next)) return;
  snapshot = next;
  for (const webContents of subscribersForChannel(KEYBINDINGS_CHANGED_CHANNEL)) {
    webContents.send(KEYBINDINGS_CHANGED_CHANNEL, next);
  }
  for (const listener of listeners) {
    listener(next);
  }
}

function parseWriteRequest(payload: unknown): KeybindingWriteRequest {
  if (payload === null || typeof payload !== "object") {
    throw new Error("keybindings:write requires a request object");
  }
  const request = payload as Record<string, unknown>;
  if (request.kind === "reset_all") return { kind: "reset_all" };
  if (request.kind === "set_many") {
    if (!Array.isArray(request.changes) || request.changes.length === 0) {
      throw new Error("keybindings:write requires a non-empty list of changes");
    }
    return {
      kind: "set_many",
      changes: request.changes.map((change: unknown) => {
        const parsed = parseWriteRequest({ ...(change as object), kind: "set" });
        if (parsed.kind !== "set") throw new Error("keybindings:write requires set changes");
        return { actionId: parsed.actionId, chords: parsed.chords };
      }),
    };
  }
  const actionId = request.actionId;
  if (typeof actionId !== "string" || !isKeybindingActionId(actionId)) {
    throw new Error("keybindings:write requires a known actionId");
  }
  if (request.kind === "reset") return { kind: "reset", actionId };
  if (request.kind === "set") {
    const chords = request.chords;
    if (!Array.isArray(chords) || chords.some((chord) => typeof chord !== "string")) {
      throw new Error("keybindings:write requires chords to be a list of strings");
    }
    return { kind: "set", actionId, chords: chords as string[] };
  }
  throw new Error("keybindings:write requires kind set, set_many, reset or reset_all");
}

export function registerKeybindingsIpcHandlers(options: { filePath?: string } = {}): void {
  if (options.filePath !== undefined) {
    filePath = options.filePath;
    snapshot = undefined;
  }
  ipcMain.removeHandler(KEYBINDINGS_READ_CHANNEL);
  ipcMain.removeHandler(KEYBINDINGS_WRITE_CHANNEL);
  ipcMain.handle(KEYBINDINGS_READ_CHANNEL, () => getKeybindingsSnapshot());
  ipcMain.handle(KEYBINDINGS_WRITE_CHANNEL, (_event, payload: unknown) => {
    const next = writeKeybindingsFile(currentFilePath(), parseWriteRequest(payload));
    publish(next);
    return next;
  });
  watcher?.close();
  // Another profile's process, or a hand edit, changed the file.
  watcher = watchKeybindingsFile(currentFilePath(), () => {
    publish(readKeybindingsFile(currentFilePath()));
  });
}

export function disposeKeybindingsIpcHandlers(): void {
  ipcMain.removeHandler(KEYBINDINGS_READ_CHANNEL);
  ipcMain.removeHandler(KEYBINDINGS_WRITE_CHANNEL);
  watcher?.close();
  watcher = undefined;
  listeners.clear();
}

/** For tests only. */
export function _resetKeybindingsIpcForTests(): void {
  disposeKeybindingsIpcHandlers();
  filePath = undefined;
  snapshot = undefined;
}
