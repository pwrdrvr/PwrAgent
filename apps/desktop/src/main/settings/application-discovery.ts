import {
  execFile as execFileCallback,
  spawn as spawnProcess,
} from "node:child_process";
import fs from "node:fs";
import { access } from "node:fs/promises";
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

const execFile = promisify(execFileCallback);

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

  return undefined;
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
  const executablePath = await resolveBinary(application, env);

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

  await openEditor(application, targetPath, env);
  return { opened: true };
}

async function openEditor(
  application: DesktopApplicationDiscoveryCandidate,
  targetPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (application.executablePath) {
    await spawnDetached(application.executablePath, [targetPath], { env });
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

  throw new Error(`${application.name} does not have an executable launcher.`);
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
    return undefined;
  }

  try {
    const { nativeImage } = await import("electron");
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      return undefined;
    }
    return image.resize({ width: 32, height: 32 }).toDataURL();
  } catch {
    return undefined;
  }
}

function findApplicationIconPath(appPath: string): string | undefined {
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const iconFile = readBundleIconFile(appPath);
  const candidates = [
    iconFile ? path.join(resourcesPath, iconFile) : undefined,
    iconFile && !path.extname(iconFile)
      ? path.join(resourcesPath, `${iconFile}.icns`)
      : undefined,
    path.join(resourcesPath, "AppIcon.icns"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(candidate));
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
