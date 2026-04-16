import path from "node:path";
import type { ToolExecutionContext } from "./tool-contract.js";
import { ToolExecutionFailure } from "./tool-errors.js";

export function requireWorkspacePath(
  context: ToolExecutionContext,
  toolName: string,
): string {
  const workspacePath = context.cwd?.trim();
  if (!workspacePath) {
    throw new ToolExecutionFailure(
      toolName,
      "thread cwd is required for repository tools",
      "missing_cwd",
    );
  }
  return workspacePath;
}

export function resolveWorkspaceFilePath(
  context: ToolExecutionContext,
  toolName: string,
  targetPath: string,
) {
  const workspacePath = requireWorkspacePath(context, toolName);
  const absolutePath = path.resolve(workspacePath, targetPath);
  const relativePath = path.relative(workspacePath, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new ToolExecutionFailure(
      toolName,
      `path escapes workspace: ${targetPath}`,
      "path_outside_workspace",
    );
  }
  return {
    workspacePath,
    absolutePath,
    relativePath: toPosix(relativePath || path.basename(absolutePath)),
  };
}

export function resolveWorkspaceScopePath(
  context: ToolExecutionContext,
  toolName: string,
  scope: string | undefined,
) {
  const workspacePath = requireWorkspacePath(context, toolName);
  const scopePath = path.resolve(workspacePath, scope ?? ".");
  const relative = path.relative(workspacePath, scopePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolExecutionFailure(
      toolName,
      `path escapes workspace: ${scope ?? "."}`,
      "path_outside_workspace",
    );
  }
  return {
    workspacePath,
    scopePath,
    scopeLabel: relative ? toPosix(relative) : ".",
    displayPath: relative ? toPosix(relative) : "workspace",
  };
}

export function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
