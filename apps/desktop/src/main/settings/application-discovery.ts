import {
  execFile as execFileCallback,
  spawn as spawnProcess,
} from "node:child_process";
import fs from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationKind,
  DesktopApplicationsSnapshot,
  OpenDesktopApplicationRequest,
  OpenDesktopApplicationResponse,
} from "@pwragent/shared";
import { getMainLogger } from "../log";

const execFile = promisify(execFileCallback);

const log = getMainLogger("pwragent:application-discovery");

// App-bundle icons are rendered at this many logical pixels. The largest
// on-screen consumer is the Settings → Applications row at ~20px, so 48px
// keeps it crisp on 2x retina displays without bloating the settings IPC
// payload with a full-resolution icon.
const APPLICATION_ICON_SIZE = 48;

type KnownApplication = {
  id: string;
  kind: DesktopApplicationKind;
  name: string;
  appPaths?: string[];
  binaryNames?: string[];
  binaryPaths?: string[];
  canOpenWorkspace?: boolean;
  macOpenStrategy?: "ghostty-applescript";
  terminalWorkingDirectoryArg?: (targetPath: string) => string[];
};

type ApplicationLaunchInvocation = {
  command: string;
  args: string[];
  cwd?: string;
  mode: "execFile" | "spawn";
};

const EDITORS: KnownApplication[] = [
  {
    id: "vscode",
    kind: "editor",
    name: "VS Code",
    appPaths: applicationPaths("Visual Studio Code.app"),
    binaryNames: ["code"],
    binaryPaths: homebrewBinaryPaths("code"),
  },
  {
    id: "cursor",
    kind: "editor",
    name: "Cursor",
    appPaths: applicationPaths("Cursor.app"),
    binaryNames: ["cursor"],
    binaryPaths: homebrewBinaryPaths("cursor"),
  },
  {
    id: "windsurf",
    kind: "editor",
    name: "Windsurf",
    appPaths: applicationPaths("Windsurf.app"),
    binaryNames: ["windsurf"],
    binaryPaths: homebrewBinaryPaths("windsurf"),
  },
  {
    id: "zed",
    kind: "editor",
    name: "Zed",
    appPaths: applicationPaths("Zed.app"),
    binaryNames: ["zed"],
    binaryPaths: homebrewBinaryPaths("zed"),
  },
  {
    id: "sublime-text",
    kind: "editor",
    name: "Sublime Text",
    appPaths: applicationPaths("Sublime Text.app"),
    binaryNames: ["subl"],
    binaryPaths: [
      "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl",
      ...homebrewBinaryPaths("subl"),
    ],
  },
  {
    id: "macvim",
    kind: "editor",
    name: "MacVim",
    appPaths: applicationPaths("MacVim.app"),
    binaryNames: ["mvim"],
    binaryPaths: homebrewBinaryPaths("mvim"),
  },
  {
    id: "neovide",
    kind: "editor",
    name: "Neovide",
    appPaths: applicationPaths("Neovide.app"),
    binaryNames: ["neovide"],
    binaryPaths: homebrewBinaryPaths("neovide"),
  },
  {
    id: "vimr",
    kind: "editor",
    name: "VimR",
    appPaths: applicationPaths("VimR.app"),
  },
  {
    id: "goneovim",
    kind: "editor",
    name: "Goneovim",
    appPaths: applicationPaths("Goneovim.app"),
    binaryNames: ["goneovim"],
    binaryPaths: homebrewBinaryPaths("goneovim"),
  },
  {
    id: "nvim-qt",
    kind: "editor",
    name: "nvim-qt",
    appPaths: [
      ...applicationPaths("nvim-qt.app"),
      ...applicationPaths("Nvim Qt.app"),
    ],
    binaryNames: ["nvim-qt"],
    binaryPaths: homebrewBinaryPaths("nvim-qt"),
  },
  {
    id: "intellijidea",
    kind: "editor",
    name: "IntelliJ IDEA",
    appPaths: [
      ...applicationPaths("IntelliJ IDEA.app"),
      ...applicationPaths("IntelliJ IDEA CE.app"),
    ],
    binaryNames: ["idea"],
    binaryPaths: [
      ...applicationExecutablePaths("IntelliJ IDEA.app", "Contents", "MacOS", "idea"),
      ...applicationExecutablePaths(
        "IntelliJ IDEA CE.app",
        "Contents",
        "MacOS",
        "idea",
      ),
    ],
  },
];

const TERMINALS: KnownApplication[] = [
  {
    id: "terminal",
    kind: "terminal",
    name: "Terminal",
    appPaths: [
      "/System/Applications/Utilities/Terminal.app",
      "/Applications/Utilities/Terminal.app",
    ],
  },
  {
    id: "ghostty",
    kind: "terminal",
    name: "Ghostty",
    appPaths: applicationPaths("Ghostty.app"),
    binaryNames: ["ghostty"],
    binaryPaths: [
      "/Applications/Ghostty.app/Contents/MacOS/ghostty",
      path.join(os.homedir(), "Applications/Ghostty.app/Contents/MacOS/ghostty"),
      ...homebrewBinaryPaths("ghostty"),
    ],
    macOpenStrategy: "ghostty-applescript",
    terminalWorkingDirectoryArg: (targetPath) => [`--working-directory=${targetPath}`],
  },
  {
    id: "iterm",
    kind: "terminal",
    name: "iTerm",
    appPaths: [...applicationPaths("iTerm.app"), ...applicationPaths("iTerm2.app")],
  },
  {
    id: "wezterm",
    kind: "terminal",
    name: "WezTerm",
    appPaths: applicationPaths("WezTerm.app"),
    binaryNames: ["wezterm"],
    binaryPaths: homebrewBinaryPaths("wezterm"),
    terminalWorkingDirectoryArg: (targetPath) => ["start", "--cwd", targetPath],
  },
  {
    id: "alacritty",
    kind: "terminal",
    name: "Alacritty",
    appPaths: applicationPaths("Alacritty.app"),
    binaryNames: ["alacritty"],
    binaryPaths: homebrewBinaryPaths("alacritty"),
    terminalWorkingDirectoryArg: (targetPath) => ["--working-directory", targetPath],
  },
  {
    id: "kitty",
    kind: "terminal",
    name: "Kitty",
    appPaths: applicationPaths("kitty.app"),
    binaryNames: ["kitty"],
    binaryPaths: homebrewBinaryPaths("kitty"),
    terminalWorkingDirectoryArg: (targetPath) => ["--directory", targetPath],
  },
  {
    id: "warp",
    kind: "terminal",
    name: "Warp",
    appPaths: applicationPaths("Warp.app"),
  },
];

function applicationPaths(appName: string): string[] {
  return [
    path.join("/Applications", appName),
    path.join(os.homedir(), "Applications", appName),
  ];
}

function homebrewBinaryPaths(binaryName: string): string[] {
  return [
    path.join("/opt/homebrew/bin", binaryName),
    path.join("/usr/local/bin", binaryName),
  ];
}

function applicationExecutablePaths(appName: string, ...segments: string[]): string[] {
  return applicationPaths(appName).map((appPath) => path.join(appPath, ...segments));
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveBinary(
  application: KnownApplication,
  env: NodeJS.ProcessEnv,
  appPath?: string,
): Promise<string | undefined> {
  const explicitPath = application.binaryPaths
    ? await firstExistingPath(application.binaryPaths)
    : undefined;
  if (explicitPath) {
    return explicitPath;
  }

  for (const binaryName of application.binaryNames ?? []) {
    try {
      const result = await execFile("/usr/bin/which", [binaryName], {
        env,
        timeout: 2_000,
      });
      const resolvedPath = result.stdout.trim();
      if (resolvedPath) {
        return resolvedPath;
      }
    } catch {
      // Missing binaries are expected during discovery.
    }
  }

  const bundledPath = appPath
    ? await resolveBundledApplicationCliPath(appPath, application.binaryNames ?? [])
    : undefined;
  if (bundledPath) {
    return bundledPath;
  }

  return undefined;
}

export async function resolveBundledApplicationCliPath(
  appPath: string,
  binaryNames: readonly string[],
): Promise<string | undefined> {
  if (binaryNames.length === 0) {
    return undefined;
  }

  return await firstExistingPath(
    binaryNames.map((binaryName) =>
      path.join(appPath, "Contents", "Resources", "app", "bin", binaryName)
    )
  );
}

async function firstExistingPath(candidates: string[]): Promise<string | undefined> {
  for (const candidatePath of candidates) {
    if (await pathExists(candidatePath)) {
      return candidatePath;
    }
  }
  return undefined;
}

async function discoverApplication(
  application: KnownApplication,
  env: NodeJS.ProcessEnv,
): Promise<DesktopApplicationDiscoveryCandidate | undefined> {
  const appPath = application.appPaths
    ? await firstExistingPath(application.appPaths)
    : undefined;
  const executablePath = await resolveBinary(application, env, appPath);

  if (!appPath && !executablePath) {
    return undefined;
  }

  return {
    id: application.id,
    kind: application.kind,
    name: application.name,
    source: appPath ? "application" : "path",
    appPath,
    executablePath,
    iconDataUrl: appPath ? await readApplicationIconDataUrl(appPath) : undefined,
    canOpenWorkspace: application.canOpenWorkspace ?? true,
  };
}

export async function discoverDesktopApplications(params?: {
  env?: NodeJS.ProcessEnv;
}): Promise<DesktopApplicationsSnapshot> {
  const env = params?.env ?? process.env;
  const [editors, terminals] = await Promise.all([
    Promise.all(EDITORS.map((application) => discoverApplication(application, env))),
    Promise.all(TERMINALS.map((application) => discoverApplication(application, env))),
  ]);

  return {
    editors: editors.filter(
      (candidate): candidate is DesktopApplicationDiscoveryCandidate => Boolean(candidate),
    ),
    terminals: terminals.filter(
      (candidate): candidate is DesktopApplicationDiscoveryCandidate => Boolean(candidate),
    ),
    preferredEditorId: { value: "", source: "default" },
    preferredTerminalId: { value: "", source: "default" },
    gh: {
      path: { value: "", source: "default" },
      discovery: { candidates: [] },
    },
    git: {
      discovery: { candidates: [] },
    },
  };
}

export async function openDesktopApplication(
  request: OpenDesktopApplicationRequest,
  params?: { env?: NodeJS.ProcessEnv },
): Promise<OpenDesktopApplicationResponse> {
  const targetPath = request.targetPath.trim();
  if (!targetPath) {
    throw new Error("No workspace path was provided.");
  }
  if (!(await pathExists(targetPath))) {
    throw new Error(`Workspace path does not exist: ${targetPath}`);
  }

  const env = params?.env ?? process.env;
  const snapshot = await discoverDesktopApplications({ env });
  const application = [...snapshot.editors, ...snapshot.terminals].find(
    (candidate) =>
      candidate.id === request.applicationId && candidate.kind === request.kind,
  );
  if (!application) {
    throw new Error("The requested application is no longer available.");
  }
  if (!application.canOpenWorkspace) {
    throw new Error(`${application.name} cannot be opened from the composer.`);
  }

  const knownApplication = [...EDITORS, ...TERMINALS].find(
    (candidate) => candidate.id === application.id && candidate.kind === application.kind,
  );

  if (application.kind === "terminal") {
    await openTerminal(application, targetPath, knownApplication, env);
    return { opened: true };
  }

  const invocation = buildEditorLaunchInvocation(application, targetPath, request);
  if (await captureApplicationOpenIfRequested(request, invocation, env)) {
    return { opened: true };
  }
  await runLaunchInvocation(invocation, env);
  return { opened: true };
}

function buildEditorLaunchInvocation(
  application: DesktopApplicationDiscoveryCandidate,
  targetPath: string,
  request: OpenDesktopApplicationRequest,
): ApplicationLaunchInvocation {
  if (application.executablePath) {
    return {
      command: application.executablePath,
      args: editorCliArgs(application.id, targetPath, request),
      mode: "spawn",
    };
  }

  if (application.appPath && process.platform === "darwin") {
    return {
      command: "/usr/bin/open",
      args: ["-a", macApplicationName(application.appPath), targetPath],
      mode: "execFile",
    };
  }

  throw new Error(`${application.name} does not have an executable launcher.`);
}

function editorCliArgs(
  applicationId: string,
  targetPath: string,
  request: OpenDesktopApplicationRequest,
): string[] {
  if (supportsJetBrainsLineArgs(applicationId) && isPositiveInteger(request.targetLine)) {
    const args = ["--line", String(request.targetLine)];
    if (isPositiveInteger(request.targetColumn)) {
      args.push("--column", String(request.targetColumn));
    }
    args.push(targetPath);
    return args;
  }

  if (!supportsVsCodeGoto(applicationId) || !isPositiveInteger(request.targetLine)) {
    return [targetPath];
  }

  const location = isPositiveInteger(request.targetColumn)
    ? `${targetPath}:${request.targetLine}:${request.targetColumn}`
    : `${targetPath}:${request.targetLine}`;
  return ["--goto", location];
}

function supportsJetBrainsLineArgs(applicationId: string): boolean {
  return applicationId === "intellijidea";
}

function supportsVsCodeGoto(applicationId: string): boolean {
  return (
    applicationId === "vscode" ||
    applicationId === "cursor" ||
    applicationId === "windsurf"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

async function runLaunchInvocation(
  invocation: ApplicationLaunchInvocation,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (invocation.mode === "spawn") {
    await spawnDetached(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env,
    });
    return;
  }

  await execFile(invocation.command, invocation.args, {
    env,
    timeout: 10_000,
  });
}

async function captureApplicationOpenIfRequested(
  request: OpenDesktopApplicationRequest,
  invocation: ApplicationLaunchInvocation,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const capturePath = env.PWRAGENT_E2E_APPLICATION_OPEN_CAPTURE_PATH;
  if (!capturePath) {
    return false;
  }

  await writeFile(
    capturePath,
    `${JSON.stringify({ request, invocation }, null, 2)}\n`,
    "utf8",
  );
  return true;
}

async function openTerminal(
  application: DesktopApplicationDiscoveryCandidate,
  targetPath: string,
  knownApplication: KnownApplication | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (
    process.platform === "darwin" &&
    knownApplication?.macOpenStrategy === "ghostty-applescript"
  ) {
    await openGhosttyWithAppleScript(targetPath, env);
    return;
  }

  if (application.executablePath && knownApplication?.terminalWorkingDirectoryArg) {
    await spawnDetached(
      application.executablePath,
      knownApplication.terminalWorkingDirectoryArg(targetPath),
      { env },
    );
    return;
  }

  if (application.appPath && process.platform === "darwin") {
    await execFile(
      "/usr/bin/open",
      ["-a", macApplicationName(application.appPath), targetPath],
      {
        env,
        timeout: 10_000,
      },
    );
    return;
  }

  if (application.executablePath) {
    await spawnDetached(application.executablePath, [], {
      cwd: targetPath,
      env,
    });
    return;
  }

  throw new Error(`${application.name} does not have an executable launcher.`);
}

async function openGhosttyWithAppleScript(
  targetPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await execFile("/usr/bin/osascript", buildGhosttyAppleScriptArgs(targetPath), {
    env,
    timeout: 10_000,
  });
}

export function buildGhosttyAppleScriptArgs(targetPath: string): string[] {
  return [
    "-e",
    'tell application "Ghostty"',
    "-e",
    "activate",
    "-e",
    "set cfg to new surface configuration",
    "-e",
    `set initial working directory of cfg to ${appleScriptString(targetPath)}`,
    "-e",
    "set win to new window with configuration cfg",
    "-e",
    "activate window win",
    "-e",
    "end tell",
  ];
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function macApplicationName(appPath: string): string {
  return path.basename(appPath, ".app");
}

async function spawnDetached(
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function readApplicationIconDataUrl(appPath: string): Promise<string | undefined> {
  const iconPath = findApplicationIconPath(appPath);
  if (!iconPath) {
    log.warn("application-icon-not-found", { appPath });
    return undefined;
  }

  try {
    const { nativeImage } = await import("electron");

    // `nativeImage.createFromPath()` returns an EMPTY image for `.icns`
    // files, so decode the container ourselves: a modern `.icns` embeds a
    // PNG per size, and `nativeImage` CAN decode PNG from a buffer. Everything
    // here is in-process — deliberately NOT `app.getFileIcon()`, which drives
    // the macOS Launch Services icon loader on a worker thread and hard-aborts
    // the whole process with an uncatchable SIGTRAP on some OS builds (the v1
    // beta crash on macOS 26).
    const fileBytes = await readFile(iconPath);
    const source = isIcnsBuffer(fileBytes) ? extractIcnsPng(fileBytes) : fileBytes;
    if (!source) {
      log.warn("application-icon-empty", { appPath, iconPath });
      return undefined;
    }

    const image = nativeImage.createFromBuffer(source);
    if (image.isEmpty()) {
      log.warn("application-icon-empty", { appPath, iconPath });
      return undefined;
    }
    return image
      .resize({
        width: APPLICATION_ICON_SIZE,
        height: APPLICATION_ICON_SIZE,
        quality: "best",
      })
      .toDataURL();
  } catch (error) {
    log.warn("application-icon-failed", {
      appPath,
      iconPath,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function findApplicationIconPath(appPath: string): string | undefined {
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const iconFile = readBundleIconFile(appPath);
  const named = [
    iconFile ? path.join(resourcesPath, iconFile) : undefined,
    iconFile && !path.extname(iconFile)
      ? path.join(resourcesPath, `${iconFile}.icns`)
      : undefined,
    path.join(resourcesPath, "AppIcon.icns"),
  ]
    // Must be a regular FILE: some bundles (e.g. Ghostty) have a directory
    // named after `CFBundleIconFile` sitting next to the real `<name>.icns`,
    // which `fs.existsSync` would wrongly accept.
    .filter((candidate): candidate is string => Boolean(candidate))
    .find(isFilePath);

  if (named) {
    return named;
  }

  // Bundles whose `Info.plist` is binary (so the UTF-8 `CFBundleIconFile`
  // match misses) and whose icon isn't `AppIcon.icns` fall back to the
  // largest `.icns` in Resources — reliably the app icon, not a doc icon.
  return largestIcnsInResources(resourcesPath);
}

function isFilePath(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function largestIcnsInResources(resourcesPath: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(resourcesPath);
  } catch {
    return undefined;
  }

  let best: { path: string; size: number } | undefined;
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".icns")) {
      continue;
    }
    const candidate = path.join(resourcesPath, entry);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (!best || stat.size > best.size)) {
        best = { path: candidate, size: stat.size };
      }
    } catch {
      // Skip entries we can't stat.
    }
  }
  return best?.path;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True when `buffer` is an Apple `.icns` icon container. */
export function isIcnsBuffer(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.toString("latin1", 0, 4) === "icns";
}

/**
 * Pull a usable PNG out of an `.icns` container. The format is a flat list of
 * entries (4-byte OSType + 4-byte big-endian length-including-header + body);
 * modern icons store one PNG per size (type codes `ic07`..`ic14`). We pick the
 * smallest PNG that is still at least 2x the render size so the downscale
 * stays crisp without decoding the 1024px entry, falling back to the largest
 * available. Returns `undefined` for legacy `.icns` that only carry
 * JPEG-2000 / raw bitmap entries (which `nativeImage` can't decode anyway).
 */
export function extractIcnsPng(buffer: Buffer): Buffer | undefined {
  const pngs: Array<{ data: Buffer; width: number }> = [];
  let offset = 8; // skip the "icns" magic + total-length header
  while (offset + 8 <= buffer.length) {
    const entryLength = buffer.readUInt32BE(offset + 4);
    if (entryLength < 8 || offset + entryLength > buffer.length) {
      break;
    }
    const body = buffer.subarray(offset + 8, offset + entryLength);
    // PNG IHDR width is the big-endian uint32 at byte 16 (8-byte signature +
    // 8-byte chunk length/type), so we need at least 20 bytes to read it.
    if (body.length >= 24 && body.subarray(0, 8).equals(PNG_MAGIC)) {
      pngs.push({ data: body, width: body.readUInt32BE(16) });
    }
    offset += entryLength;
  }

  if (pngs.length === 0) {
    return undefined;
  }

  const minWidth = APPLICATION_ICON_SIZE * 2;
  const crispEnough = pngs
    .filter((entry) => entry.width >= minWidth)
    .sort((a, b) => a.width - b.width);
  if (crispEnough.length > 0) {
    return crispEnough[0].data;
  }
  return pngs.sort((a, b) => b.width - a.width)[0].data;
}

function readBundleIconFile(appPath: string): string | undefined {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(plistPath)) {
    return undefined;
  }

  const plist = fs.readFileSync(plistPath, "utf8");
  const match = plist.match(
    /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/,
  );
  return match?.[1]?.trim() || undefined;
}
