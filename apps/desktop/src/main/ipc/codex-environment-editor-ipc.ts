import { stat } from "node:fs/promises";
import path from "node:path";
import { ipcMain } from "electron";
import type {
  CodexEnvironmentProject,
  ListCodexEnvironmentFilesRequest,
  ListCodexEnvironmentFilesResponse,
  ListCodexEnvironmentProjectsResponse,
  ReadCodexEnvironmentDocumentRequest,
  ReadCodexEnvironmentDocumentResponse,
  SaveCodexEnvironmentDocumentRequest,
  SaveCodexEnvironmentDocumentResponse,
} from "@pwragent/shared";
import {
  listCodexEnvironmentFiles,
  readCodexEnvironmentFile,
  saveCodexEnvironmentFile,
} from "../app-server/codex-environment-editor";
import { readLocalNavigationDirectoryIndex } from "../app-server/navigation-directory-index";
import {
  CODEX_ENVIRONMENT_EDITOR_LIST_FILES_CHANNEL,
  CODEX_ENVIRONMENT_EDITOR_LIST_PROJECTS_CHANNEL,
  CODEX_ENVIRONMENT_EDITOR_READ_CHANNEL,
  CODEX_ENVIRONMENT_EDITOR_SAVE_CHANNEL,
} from "../../shared/ipc";

/** The Directories lens's checkouts on this machine. */
async function listLocalProjects(): Promise<CodexEnvironmentProject[]> {
  const seen = new Set<string>();
  const projects: CodexEnvironmentProject[] = [];
  for (const directory of await readLocalNavigationDirectoryIndex()) {
    if (!directory.path || seen.has(directory.path)) continue;
    seen.add(directory.path);
    projects.push({ path: directory.path, label: directory.label });
  }
  return projects.sort((a, b) => a.label.localeCompare(b.label));
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The editor writes only `<project>/.codex/environments/*.toml`. The project
 * must be a checkout PwrAgent lists, or a Git checkout such as a thread's
 * worktree, so the renderer cannot point it at an arbitrary directory.
 */
export async function assertEditableEnvironmentProject(
  directoryPath: string,
  listProjects: () => Promise<CodexEnvironmentProject[]> = listLocalProjects,
): Promise<string> {
  const resolved = path.resolve(directoryPath.trim());
  if (!path.isAbsolute(directoryPath.trim()) || !(await stat(resolved).then((entry) => entry.isDirectory(), () => false))) {
    throw new Error("Choose a project folder on this machine.");
  }
  if (await exists(path.join(resolved, ".git"))) {
    return resolved;
  }
  if ((await listProjects()).some((project) => path.resolve(project.path) === resolved)) {
    return resolved;
  }
  throw new Error("This folder is not a project PwrAgent knows.");
}

export function registerCodexEnvironmentEditorIpcHandlers(): void {
  ipcMain.removeHandler(CODEX_ENVIRONMENT_EDITOR_LIST_PROJECTS_CHANNEL);
  ipcMain.handle(
    CODEX_ENVIRONMENT_EDITOR_LIST_PROJECTS_CHANNEL,
    async (): Promise<ListCodexEnvironmentProjectsResponse> => ({
      projects: await listLocalProjects(),
    }),
  );

  ipcMain.removeHandler(CODEX_ENVIRONMENT_EDITOR_LIST_FILES_CHANNEL);
  ipcMain.handle(
    CODEX_ENVIRONMENT_EDITOR_LIST_FILES_CHANNEL,
    async (
      _event,
      request: ListCodexEnvironmentFilesRequest,
    ): Promise<ListCodexEnvironmentFilesResponse> => {
      const directoryPath = await assertEditableEnvironmentProject(request.directoryPath);
      return { ...(await listCodexEnvironmentFiles(directoryPath)), directoryPath: request.directoryPath };
    },
  );

  ipcMain.removeHandler(CODEX_ENVIRONMENT_EDITOR_READ_CHANNEL);
  ipcMain.handle(
    CODEX_ENVIRONMENT_EDITOR_READ_CHANNEL,
    async (
      _event,
      request: ReadCodexEnvironmentDocumentRequest,
    ): Promise<ReadCodexEnvironmentDocumentResponse> => {
      const directoryPath = await assertEditableEnvironmentProject(request.directoryPath);
      return await readCodexEnvironmentFile({ ...request, directoryPath });
    },
  );

  ipcMain.removeHandler(CODEX_ENVIRONMENT_EDITOR_SAVE_CHANNEL);
  ipcMain.handle(
    CODEX_ENVIRONMENT_EDITOR_SAVE_CHANNEL,
    async (
      _event,
      request: SaveCodexEnvironmentDocumentRequest,
    ): Promise<SaveCodexEnvironmentDocumentResponse> => {
      const directoryPath = await assertEditableEnvironmentProject(request.directoryPath);
      return await saveCodexEnvironmentFile({ ...request, directoryPath });
    },
  );
}
