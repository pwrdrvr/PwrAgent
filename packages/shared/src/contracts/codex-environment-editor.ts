/**
 * The environment editor's view of one `.codex/environments/*.toml` file.
 *
 * The file format is Codex's. A setup or cleanup script has a default
 * (`[setup] script`) and optional per-platform scripts
 * (`[setup.darwin] script`, ...) that replace it on that platform. An action is
 * one `[[actions]]` entry; Codex writes an action with per-platform commands as
 * consecutive entries that share a name and icon, one `platform` each. The
 * editor shows those as one action.
 */

export const CODEX_ENVIRONMENT_PLATFORMS = ["darwin", "linux", "win32"] as const;
export type CodexEnvironmentPlatform = (typeof CODEX_ENVIRONMENT_PLATFORMS)[number];

export const CODEX_ENVIRONMENT_PLATFORM_LABELS: Record<CodexEnvironmentPlatform, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** The icons Codex's own editor offers. Other values are kept as written. */
export const CODEX_ENVIRONMENT_ACTION_ICONS = ["tool", "run", "debug", "test"] as const;
export type CodexEnvironmentActionIcon = (typeof CODEX_ENVIRONMENT_ACTION_ICONS)[number];
/** Codex's default for a new action. */
export const CODEX_ENVIRONMENT_DEFAULT_ACTION_ICON: CodexEnvironmentActionIcon = "tool";

export type CodexEnvironmentScriptMode = "shared" | "perPlatform";

export type CodexEnvironmentScriptDocument = {
  /** `shared`: one script for every platform. `perPlatform`: a script per
   *  platform, where a platform without its own script runs `script`. */
  mode: CodexEnvironmentScriptMode;
  /** The default script, `[setup] script`. */
  script: string;
  /** A platform's own script, `[setup.<platform>] script`. Absent means the
   *  platform runs `script`. Ignored in `shared` mode, which removes them. */
  platformScripts: Partial<Record<CodexEnvironmentPlatform, string>>;
};

export type CodexEnvironmentActionDocument = {
  /** Stable within one editing session; not written to the file. */
  key: string;
  name: string;
  icon: string;
  mode: CodexEnvironmentScriptMode;
  /** The command in `shared` mode. */
  command: string;
  /** Commands in `perPlatform` mode. A platform without one has no action. */
  platformCommands: Partial<Record<CodexEnvironmentPlatform, string>>;
  /**
   * The `[[actions]]` entries this action was read from, by position among
   * the file's `[[actions]]` entries. Main reuses them on save, so their
   * comments and unknown keys survive. Absent for a new action.
   */
  sourceEntries?: Partial<Record<CodexEnvironmentPlatform | "all", number>>;
};

export type CodexEnvironmentDocument = {
  name: string;
  setup: CodexEnvironmentScriptDocument;
  cleanup: CodexEnvironmentScriptDocument;
  actions: CodexEnvironmentActionDocument[];
};

export type CodexEnvironmentFileSummary = {
  fileName: string;
  /** `name`, when the file can be read and has one. */
  name?: string;
  /** Platforms whose setup differs from the default; empty for one script. */
  setupPlatforms: CodexEnvironmentPlatform[];
  actionCount: number;
  /** Why the editor can't open the file. */
  error?: { message: string; line?: number };
};

export type CodexEnvironmentProject = {
  path: string;
  label: string;
};

export type ListCodexEnvironmentProjectsResponse = {
  projects: CodexEnvironmentProject[];
};

export type ListCodexEnvironmentFilesRequest = { directoryPath: string };
export type ListCodexEnvironmentFilesResponse = {
  directoryPath: string;
  files: CodexEnvironmentFileSummary[];
};

export type ReadCodexEnvironmentDocumentRequest = {
  directoryPath: string;
  fileName: string;
};
export type ReadCodexEnvironmentDocumentResponse =
  | {
      status: "ok";
      document: CodexEnvironmentDocument;
      /** Hash of the file as read; a save must name it. */
      revision: string;
      sourcePath: string;
    }
  | {
      status: "unreadable";
      message: string;
      line?: number;
      /** Up to five numbered lines around `line`. */
      excerpt?: Array<{ line: number; text: string }>;
      sourcePath: string;
    }
  | { status: "missing"; sourcePath: string };

export type SaveCodexEnvironmentDocumentRequest = {
  directoryPath: string;
  fileName: string;
  document: CodexEnvironmentDocument;
  /** The revision the edits started from. Absent creates a new file. */
  expectedRevision?: string;
};
export type SaveCodexEnvironmentDocumentResponse =
  | {
      status: "saved";
      document: CodexEnvironmentDocument;
      revision: string;
      sourcePath: string;
    }
  /** The file changed on disk after `expectedRevision` was read. */
  | { status: "conflict" }
  /** A new file's name is taken. */
  | { status: "exists" }
  | { status: "invalid"; problems: CodexEnvironmentProblem[] }
  | { status: "unreadable"; message: string };

export type CodexEnvironmentProblem = {
  /** `name`, `fileName`, or `action:<key>`. */
  field: string;
  message: string;
};

const ENVIRONMENT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.toml$/;

export function isValidCodexEnvironmentFileName(fileName: string): boolean {
  return ENVIRONMENT_FILE_NAME.test(fileName) && !fileName.includes("..");
}

/** A file name for a new environment, from its name. */
export function suggestCodexEnvironmentFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "environment"}.toml`;
}

/** An action the operator added and left blank. Codex drops these. */
export function isBlankCodexEnvironmentAction(
  action: CodexEnvironmentActionDocument,
): boolean {
  return !action.name.trim()
    && !action.command.trim()
    && Object.values(action.platformCommands).every((command) => !command?.trim());
}

export function codexEnvironmentActionCommands(
  action: CodexEnvironmentActionDocument,
): string[] {
  return action.mode === "shared"
    ? [action.command]
    : CODEX_ENVIRONMENT_PLATFORMS.flatMap((platform) => {
        const command = action.platformCommands[platform];
        return command === undefined ? [] : [command];
      });
}

/**
 * Codex's rules: an environment needs a name, and an action needs both a name
 * and a command. A blank action is dropped, not reported.
 */
export function validateCodexEnvironmentDocument(
  document: CodexEnvironmentDocument,
): CodexEnvironmentProblem[] {
  const problems: CodexEnvironmentProblem[] = [];
  if (!document.name.trim()) {
    problems.push({ field: "name", message: "Enter a name." });
  }
  for (const action of document.actions) {
    if (isBlankCodexEnvironmentAction(action)) continue;
    const field = `action:${action.key}`;
    if (!action.name.trim()) {
      problems.push({ field, message: "Add a name, or delete this action." });
      continue;
    }
    if (!codexEnvironmentActionCommands(action).some((command) => command.trim())) {
      problems.push({ field, message: "Add a command, or delete this action." });
    }
  }
  return problems;
}
