import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CODEX_ENVIRONMENT_PLATFORMS,
  isBlankCodexEnvironmentAction,
  isValidCodexEnvironmentFileName,
  validateCodexEnvironmentDocument,
  type CodexEnvironmentActionDocument,
  type CodexEnvironmentDocument,
  type CodexEnvironmentFileSummary,
  type CodexEnvironmentPlatform,
  type CodexEnvironmentScriptDocument,
  type ListCodexEnvironmentFilesResponse,
  type ReadCodexEnvironmentDocumentRequest,
  type ReadCodexEnvironmentDocumentResponse,
  type SaveCodexEnvironmentDocumentRequest,
  type SaveCodexEnvironmentDocumentResponse,
} from "@pwragent/shared";
import {
  CodexEnvironmentTomlError,
  formatCodexTomlValue,
  tokenizeCodexEnvironmentToml,
  type CodexTomlBlock,
  type CodexTomlDocument,
  type CodexTomlEntry,
  type CodexTomlScalar,
} from "./codex-environment-toml";

/**
 * Reads and writes one `.codex/environments/*.toml` file for the environment
 * editor. A save edits only the keys the operator changed: comments, unknown
 * keys and tables, key order and line endings stay as they were. Action
 * entries move as whole blocks, comments directly above them included.
 */

type ScriptSection = "setup" | "cleanup";

const NEW_FILE_SOURCE = "version = 1\n";

export type CodexEnvironmentSourceReadResult =
  | { status: "ok"; document: CodexEnvironmentDocument }
  | { status: "unreadable"; message: string; line?: number };

export function readCodexEnvironmentDocumentSource(
  source: string,
  filePath = "<inline>",
): CodexEnvironmentSourceReadResult {
  try {
    return { status: "ok", document: documentFromToml(tokenizeCodexEnvironmentToml(source, filePath)) };
  } catch (error) {
    if (error instanceof CodexEnvironmentTomlError) {
      return { status: "unreadable", message: describeTomlError(error), line: error.line };
    }
    throw error;
  }
}

/** The source with `document` applied. Throws when the source is unreadable. */
export function writeCodexEnvironmentDocumentSource(
  source: string,
  document: CodexEnvironmentDocument,
): string {
  const toml = tokenizeCodexEnvironmentToml(source);
  // Validates shape (duplicate tables, unknown platforms) before editing.
  documentFromToml(toml);
  return new EnvironmentSourceEditor(toml).apply(document);
}

export function createCodexEnvironmentDocumentSource(document: CodexEnvironmentDocument): string {
  return writeCodexEnvironmentDocumentSource(NEW_FILE_SOURCE, document);
}

// ---------------------------------------------------------------------------
// Files

function environmentsDirectory(directoryPath: string): string {
  const trimmed = directoryPath.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error("Environment project path must be absolute.");
  }
  return path.join(trimmed, ".codex", "environments");
}

function environmentFilePath(directoryPath: string, fileName: string): string {
  if (!isValidCodexEnvironmentFileName(fileName)) {
    throw new Error(`Invalid environment file name: ${fileName}`);
  }
  return path.join(environmentsDirectory(directoryPath), fileName);
}

function revisionOf(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

export async function listCodexEnvironmentFiles(
  directoryPath: string,
): Promise<ListCodexEnvironmentFilesResponse> {
  const directory = environmentsDirectory(directoryPath);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { directoryPath, files: [] };
    }
    throw error;
  }

  const names = entries
    .filter((fileName) => fileName.endsWith(".toml") && isValidCodexEnvironmentFileName(fileName))
    .sort((a, b) => a.localeCompare(b));
  const summaries = await Promise.all(
    names.map((fileName) => summarizeEnvironmentFile(directory, fileName)),
  );
  return {
    directoryPath,
    files: summaries.filter((summary): summary is CodexEnvironmentFileSummary => summary !== undefined),
  };
}

/**
 * One row of the list. A file that vanished since `readdir`, or a dangling
 * link, is left out; any other read failure is listed as unreadable, so one
 * bad file never hides the rest.
 */
async function summarizeEnvironmentFile(
  directory: string,
  fileName: string,
): Promise<CodexEnvironmentFileSummary | undefined> {
  const filePath = path.join(directory, fileName);
  let source: string;
  try {
    if (!(await stat(filePath)).isFile()) return undefined;
    source = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return {
      fileName,
      setupPlatforms: [],
      actionCount: 0,
      error: { message: `PwrAgent can't read this file (${code ?? errorText(error)}).` },
    };
  }
  const result = readCodexEnvironmentDocumentSource(source, filePath);
  if (result.status !== "ok") {
    return {
      fileName,
      setupPlatforms: [],
      actionCount: 0,
      error: { message: result.message, ...(result.line ? { line: result.line } : {}) },
    };
  }
  const { document } = result;
  return {
    fileName,
    ...(document.name.trim() ? { name: document.name.trim() } : {}),
    setupPlatforms: document.setup.mode === "perPlatform"
      ? CODEX_ENVIRONMENT_PLATFORMS.filter((platform) =>
        document.setup.platformScripts[platform] !== undefined)
      : [],
    actionCount: document.actions.length,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readCodexEnvironmentFile(
  request: ReadCodexEnvironmentDocumentRequest,
): Promise<ReadCodexEnvironmentDocumentResponse> {
  const sourcePath = environmentFilePath(request.directoryPath, request.fileName);
  const source = await readOptional(sourcePath);
  if (source === undefined) {
    return { status: "missing", sourcePath };
  }
  const result = readCodexEnvironmentDocumentSource(source, sourcePath);
  if (result.status === "ok") {
    return { status: "ok", document: result.document, revision: revisionOf(source), sourcePath };
  }
  return {
    status: "unreadable",
    message: result.message,
    sourcePath,
    ...(result.line
      ? { line: result.line, excerpt: excerptAround(source, result.line) }
      : {}),
  };
}

export async function saveCodexEnvironmentFile(
  request: SaveCodexEnvironmentDocumentRequest,
): Promise<SaveCodexEnvironmentDocumentResponse> {
  const sourcePath = environmentFilePath(request.directoryPath, request.fileName);
  const problems = validateCodexEnvironmentDocument(request.document);
  if (problems.length > 0) {
    return { status: "invalid", problems };
  }

  const current = await readOptional(sourcePath);
  if (request.expectedRevision === undefined) {
    if (current !== undefined) return { status: "exists" };
  } else if (current === undefined || revisionOf(current) !== request.expectedRevision) {
    return { status: "conflict" };
  }

  let next: string;
  try {
    next = current === undefined
      ? createCodexEnvironmentDocumentSource(request.document)
      : writeCodexEnvironmentDocumentSource(current, request.document);
  } catch (error) {
    if (error instanceof CodexEnvironmentTomlError) {
      return { status: "unreadable", message: describeTomlError(error) };
    }
    throw error;
  }

  if (next !== current) {
    await mkdir(path.dirname(sourcePath), { recursive: true });
    // Write beside the file, then rename over it, so a crash never leaves a
    // half-written environment.
    const temporary = path.join(path.dirname(sourcePath), `.${request.fileName}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, next, { encoding: "utf8", flag: "wx" });
      if (request.expectedRevision === undefined) {
        // A new file must not replace one that appeared since the check
        // above. link() fails when the name exists; rename() would not.
        if (!(await linkIfAbsent(temporary, sourcePath))) {
          return { status: "exists" };
        }
      } else {
        await rename(temporary, sourcePath);
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  const saved = readCodexEnvironmentDocumentSource(next, sourcePath);
  if (saved.status !== "ok") {
    return { status: "unreadable", message: saved.message };
  }
  return { status: "saved", document: saved.document, revision: revisionOf(next), sourcePath };
}

/**
 * Gives `temporary`'s content the name `target` only if nothing has it yet.
 * A volume without hard links gets an exclusive copy instead. Either way an
 * existing file is never replaced. Answers false when `target` exists.
 */
async function linkIfAbsent(temporary: string, target: string): Promise<boolean> {
  try {
    await link(temporary, target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV") {
      throw error;
    }
  }
  try {
    await copyFile(temporary, target, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function excerptAround(source: string, line: number): Array<{ line: number; text: string }> {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  const first = Math.max(1, line - 2);
  const last = Math.min(lines.length, line + 2);
  const excerpt: Array<{ line: number; text: string }> = [];
  for (let number = first; number <= last; number += 1) {
    excerpt.push({ line: number, text: lines[number - 1] ?? "" });
  }
  return excerpt;
}

function describeTomlError(error: CodexEnvironmentTomlError): string {
  if (error.reason.startsWith("Unsupported")) {
    return `Line ${error.line} has a value PwrAgent can't read.`;
  }
  if (error.reason.startsWith("Unterminated")) {
    return `The string that starts on line ${error.line} never ends.`;
  }
  return `Line ${error.line} is not valid TOML here.`;
}

// ---------------------------------------------------------------------------
// TOML -> document

function isPlatform(value: string): value is CodexEnvironmentPlatform {
  return (CODEX_ENVIRONMENT_PLATFORMS as readonly string[]).includes(value);
}

function stringEntry(block: CodexTomlBlock, key: string): string | undefined {
  const entry = block.entries.find((candidate) => candidate.key === key);
  return typeof entry?.value === "string" ? entry.value : undefined;
}

function shapeError(reason: string, line: number): CodexEnvironmentTomlError {
  return new CodexEnvironmentTomlError(reason, line, "<inline>");
}

function documentFromToml(toml: CodexTomlDocument): CodexEnvironmentDocument {
  const seenTables = new Set<string>();
  const scripts: Record<ScriptSection, CodexEnvironmentScriptDocument> = {
    setup: { mode: "shared", script: "", platformScripts: {} },
    cleanup: { mode: "shared", script: "", platformScripts: {} },
  };
  const actions: CodexEnvironmentActionDocument[] = [];
  let name = "";
  let actionIndex = 0;

  for (const block of toml.blocks) {
    const header = block.header;
    if (!header) {
      name = stringEntry(block, "name") ?? "";
      continue;
    }
    if (header.kind === "table") {
      if (seenTables.has(header.name)) {
        throw shapeError(`Duplicate [${header.name}] table`, header.line + 1);
      }
      seenTables.add(header.name);
      const [section, platform, ...rest] = header.name.split(".");
      if ((section === "setup" || section === "cleanup") && rest.length === 0) {
        const script = stringEntry(block, "script");
        if (!platform) {
          scripts[section].script = script ?? "";
        } else if (isPlatform(platform) && script !== undefined) {
          scripts[section].platformScripts[platform] = script;
          scripts[section].mode = "perPlatform";
        }
      }
      continue;
    }
    if (header.name !== "actions") continue;

    const index = actionIndex;
    actionIndex += 1;
    const actionName = stringEntry(block, "name") ?? "";
    const icon = stringEntry(block, "icon") ?? "";
    const command = stringEntry(block, "command") ?? "";
    const platformEntry = block.entries.find((entry) => entry.key === "platform");
    const platform = typeof platformEntry?.value === "string" ? platformEntry.value : undefined;
    if (platform === undefined) {
      actions.push({
        key: `entry-${index}`,
        name: actionName,
        icon,
        mode: "shared",
        command,
        platformCommands: {},
        sourceEntries: { all: index },
      });
      continue;
    }
    if (!isPlatform(platform)) {
      throw shapeError(`Unsupported action platform "${platform}"`, platformEntry!.startLine + 1);
    }
    // Codex writes an action's per-platform commands as consecutive entries.
    const previous = actions.at(-1);
    const previousLast = previous?.sourceEntries
      ? Math.max(...Object.values(previous.sourceEntries))
      : -1;
    if (
      previous?.mode === "perPlatform"
      && previousLast === index - 1
      && previous.name === actionName
      && previous.icon === icon
      && previous.platformCommands[platform] === undefined
    ) {
      previous.platformCommands[platform] = command;
      previous.sourceEntries = { ...previous.sourceEntries, [platform]: index };
      continue;
    }
    actions.push({
      key: `entry-${index}`,
      name: actionName,
      icon,
      mode: "perPlatform",
      command: "",
      platformCommands: { [platform]: command },
      sourceEntries: { [platform]: index },
    });
  }

  return { name, setup: scripts.setup, cleanup: scripts.cleanup, actions };
}

// ---------------------------------------------------------------------------
// document -> TOML

type EditableBlock = {
  header?: CodexTomlBlock["header"];
  /** The block's lines; edits rewrite them in place. */
  lines: string[];
  entries: Array<{ key: string; value: CodexTomlScalar; offset: number; length: number; trailing: string }>;
  /** Index among the file's `[[actions]]` blocks. */
  actionIndex?: number;
  created?: boolean;
};

type PlannedAction = {
  block: EditableBlock;
  values: { name: string; icon: string; command: string; platform?: CodexEnvironmentPlatform };
};

class EnvironmentSourceEditor {
  private readonly eol: string;
  private readonly bom: boolean;
  private readonly trailingNewline: boolean;
  private blocks: EditableBlock[];

  constructor(toml: CodexTomlDocument) {
    this.eol = toml.eol;
    this.bom = toml.bom;
    const lines = [...toml.lines];
    this.trailingNewline = lines.length > 1 && lines.at(-1) === "";
    if (this.trailingNewline) lines.pop();
    let actionIndex = 0;
    this.blocks = toml.blocks.map((block) => {
      const end = Math.min(block.end, lines.length);
      return {
        header: block.header,
        lines: lines.slice(block.start, end),
        entries: block.entries.map((entry: CodexTomlEntry) => ({
          key: entry.key,
          value: entry.value,
          offset: entry.startLine - block.start,
          length: entry.endLine - entry.startLine,
          trailing: entry.trailing,
        })),
        ...(block.header?.kind === "array" && block.header.name === "actions"
          ? { actionIndex: actionIndex++ }
          : {}),
      };
    });
    // An empty file has a preamble with no lines; keep the structure uniform.
    if (this.blocks.length === 0 || this.blocks[0]!.header) {
      this.blocks.unshift({ lines: [], entries: [] });
    }
  }

  apply(document: CodexEnvironmentDocument): string {
    this.setTopLevelName(document.name.trim());
    this.applyScripts("setup", document.setup);
    this.applyScripts("cleanup", document.cleanup);
    this.applyActions(document.actions);
    const lines = this.blocks.flatMap((block) => block.lines);
    if (this.trailingNewline || lines.length === 0 || this.blocks.some((block) => block.created)) {
      lines.push("");
    }
    return `${this.bom ? "﻿" : ""}${lines.join(this.eol)}`;
  }

  // -- keys ------------------------------------------------------------------

  private setKey(block: EditableBlock, key: string, value: CodexTomlScalar): void {
    const entry = block.entries.find((candidate) => candidate.key === key);
    if (entry && entry.value === value) return;
    const text = `${key} = ${formatCodexTomlValue(value)}`;
    const newLines = text.split("\n");
    if (entry) {
      // The comment after the value, single-line or after a closing """.
      newLines[newLines.length - 1] += entry.trailing;
      this.replaceLines(block, entry.offset, entry.length, newLines);
      entry.value = value;
      entry.length = newLines.length;
      return;
    }
    const last = block.entries.at(-1);
    const offset = last
      ? last.offset + last.length
      : block.header
        ? block.lines.findIndex((_line, index) => index >= 0 && isHeaderLine(block, index)) + 1
        : trimmedLength(block.lines);
    this.replaceLines(block, offset, 0, newLines);
    block.entries.push({ key, value, offset, length: newLines.length, trailing: "" });
  }

  private deleteKey(block: EditableBlock, key: string): void {
    const entry = block.entries.find((candidate) => candidate.key === key);
    if (!entry) return;
    this.replaceLines(block, entry.offset, entry.length, []);
    block.entries = block.entries.filter((candidate) => candidate !== entry);
  }

  private replaceLines(block: EditableBlock, offset: number, count: number, lines: string[]): void {
    block.lines.splice(offset, count, ...lines);
    const delta = lines.length - count;
    for (const entry of block.entries) {
      if (entry.offset > offset || (entry.offset === offset && count === 0 && delta > 0)) {
        entry.offset += delta;
      }
    }
  }

  // -- name ------------------------------------------------------------------

  private setTopLevelName(name: string): void {
    const preamble = this.blocks[0]!;
    const current = preamble.entries.find((entry) => entry.key === "name");
    if (current?.value === name || (!current && !name)) return;
    this.setKey(preamble, "name", name);
  }

  // -- scripts ---------------------------------------------------------------

  private table(name: string): EditableBlock | undefined {
    return this.blocks.find((block) => block.header?.kind === "table" && block.header.name === name);
  }

  private applyScripts(section: ScriptSection, scripts: CodexEnvironmentScriptDocument): void {
    const defaultScript = normalizeText(scripts.script);
    const main = this.table(section);
    const currentDefault = main?.entries.find((entry) => entry.key === "script")?.value;
    if (main) {
      if (currentDefault !== defaultScript) this.setKey(main, "script", defaultScript);
    } else if (defaultScript) {
      this.setKey(this.createTable(section), "script", defaultScript);
    }

    for (const platform of CODEX_ENVIRONMENT_PLATFORMS) {
      const tableName = `${section}.${platform}`;
      const existing = this.table(tableName);
      const existingScript = existing?.entries.find((entry) => entry.key === "script")?.value;
      const wanted = scripts.mode === "perPlatform"
        ? scripts.platformScripts[platform]
        : undefined;
      const normalized = wanted === undefined ? undefined : normalizeText(wanted);
      // An untouched empty platform script means "no setup here" to the
      // PwrAgent runtime; keep it. Any other empty or default-equal script
      // falls back to the default and is not written.
      const keep = normalized !== undefined
        && (normalized === existingScript
          || (normalized !== "" && normalized !== defaultScript));
      if (keep) {
        if (existing) {
          if (existingScript !== normalized) this.setKey(existing, "script", normalized);
        } else {
          this.setKey(this.createTable(tableName), "script", normalized);
        }
        continue;
      }
      if (!existing) continue;
      this.deleteKey(existing, "script");
      if (existing.entries.length === 0) this.removeBlock(existing);
    }
  }

  /** A new table after its section's tables, or before the first action. */
  private createTable(name: string): EditableBlock {
    const section = name.split(".")[0]!;
    const family = (block: EditableBlock, prefix: string) =>
      block.header?.kind === "table"
      && (block.header.name === prefix || block.header.name.startsWith(`${prefix}.`));
    let index = findLastIndex(this.blocks, (block) => family(block, section));
    if (index < 0 && section === "cleanup") {
      index = findLastIndex(this.blocks, (block) => family(block, "setup"));
    }
    if (index < 0) {
      const firstArray = this.blocks.findIndex((block) => block.header?.kind === "array");
      index = firstArray < 0 ? this.blocks.length - 1 : firstArray - 1;
    }
    const block: EditableBlock = {
      header: { kind: "table", name, line: -1 },
      lines: [`[${name}]`],
      entries: [],
      created: true,
    };
    this.insertBlockAfter(index, block);
    return block;
  }

  private insertBlockAfter(index: number, block: EditableBlock): void {
    const previous = this.blocks[index];
    if (previous) ensureTrailingBlank(previous.lines);
    const next = this.blocks[index + 1];
    if (next) block.lines.push("");
    this.blocks.splice(index + 1, 0, block);
  }

  private removeBlock(block: EditableBlock): void {
    const index = this.blocks.indexOf(block);
    if (index < 0) return;
    this.blocks.splice(index, 1);
    const previous = this.blocks[index - 1];
    if (previous && index >= this.blocks.length) {
      // The file now ends with the previous block; drop the blank lines that
      // separated it from the removed one.
      while (previous.lines.length > 0 && previous.lines.at(-1)!.trim() === "") {
        previous.lines.pop();
      }
    }
  }

  // -- actions ---------------------------------------------------------------

  private applyActions(actions: CodexEnvironmentActionDocument[]): void {
    const original = this.blocks.filter((block) => block.actionIndex !== undefined);
    const byIndex = new Map(original.map((block) => [block.actionIndex!, block]));
    const used = new Set<number>();
    const take = (index: number | undefined): EditableBlock | undefined => {
      if (index === undefined || used.has(index)) return undefined;
      const block = byIndex.get(index);
      if (block) used.add(index);
      return block;
    };
    const fresh = (): EditableBlock => ({
      header: { kind: "array", name: "actions", line: -1 },
      lines: ["[[actions]]"],
      entries: [],
      created: true,
    });

    const planned: PlannedAction[] = [];
    for (const action of actions) {
      if (isBlankCodexEnvironmentAction(action)) continue;
      const sources = action.sourceEntries ?? {};
      const values = { name: action.name.trim(), icon: action.icon };
      if (action.mode === "shared") {
        const reuse = take(sources.all)
          ?? CODEX_ENVIRONMENT_PLATFORMS.map((platform) => take(sources[platform])).find(Boolean);
        planned.push({ block: reuse ?? fresh(), values: { ...values, command: action.command } });
        continue;
      }
      for (const platform of CODEX_ENVIRONMENT_PLATFORMS) {
        const command = action.platformCommands[platform];
        if (command === undefined || !command.trim()) continue;
        const reuse = take(sources[platform]) ?? take(sources.all);
        planned.push({ block: reuse ?? fresh(), values: { ...values, command, platform } });
      }
    }

    for (const { block, values } of planned) {
      this.setKey(block, "name", values.name);
      if (values.icon) {
        this.setKey(block, "icon", values.icon);
      } else {
        this.deleteKey(block, "icon");
      }
      this.setKey(block, "command", values.command);
      if (values.platform) {
        this.setKey(block, "platform", values.platform);
      } else {
        this.deleteKey(block, "platform");
      }
    }

    const unchangedOrder = planned.length === original.length
      && planned.every(({ block }, index) => block.actionIndex === index);
    if (unchangedOrder) return;

    const firstIndex = this.blocks.findIndex((block) => block.actionIndex !== undefined);
    const insertAt = firstIndex < 0 ? this.blocks.length : firstIndex;
    const before = this.blocks.slice(0, insertAt).filter((block) => block.actionIndex === undefined);
    const after = this.blocks.slice(insertAt).filter((block) => block.actionIndex === undefined);
    const region = planned.map(({ block }) => block);
    for (const block of region) {
      while (block.lines.length > 1 && block.lines.at(-1)!.trim() === "") block.lines.pop();
      block.created = block.created || false;
    }
    region.forEach((block, index) => {
      if (index < region.length - 1 || after.length > 0) block.lines.push("");
    });
    const previous = before.at(-1);
    if (previous && region.length > 0) ensureTrailingBlank(previous.lines);
    if (previous && region.length === 0 && after.length === 0) {
      while (previous.lines.length > 0 && previous.lines.at(-1)!.trim() === "") previous.lines.pop();
    }
    this.blocks = [...before, ...region, ...after];
  }
}

function isHeaderLine(block: EditableBlock, index: number): boolean {
  const line = block.lines[index]!.trim();
  return line.startsWith("[");
}

function trimmedLength(lines: string[]): number {
  let length = lines.length;
  while (length > 0 && lines[length - 1]!.trim() === "") length -= 1;
  return length;
}

function ensureTrailingBlank(lines: string[]): void {
  if (lines.length > 0 && lines.at(-1)!.trim() !== "") lines.push("");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
