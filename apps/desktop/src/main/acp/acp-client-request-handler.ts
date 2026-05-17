import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ThreadExecutionMode } from "@pwragent/shared";

export type AcpClientRequestResult =
  | { outcome: "allowed"; result?: unknown }
  | { outcome: "permission-required"; reason: string }
  | { outcome: "denied"; reason: string };

export class AcpClientRequestHandler {
  constructor(
    private readonly options: {
      executionMode: ThreadExecutionMode;
      workspaceRoots: string[];
    },
  ) {}

  async writeTextFile(request: {
    path: string;
    content: string;
  }): Promise<AcpClientRequestResult> {
    if (!this.pathAllowed(request.path)) {
      return { outcome: "denied", reason: "path-outside-workspace" };
    }
    if (this.options.executionMode !== "full-access") {
      return { outcome: "permission-required", reason: "write-requires-approval" };
    }

    await mkdir(path.dirname(request.path), { recursive: true });
    await writeFile(request.path, request.content, "utf8");
    return { outcome: "allowed" };
  }

  async createTerminal(request: {
    cwd: string;
    command: string;
  }): Promise<AcpClientRequestResult> {
    if (!this.pathAllowed(request.cwd)) {
      return { outcome: "denied", reason: "cwd-outside-workspace" };
    }
    if (this.options.executionMode !== "full-access") {
      return {
        outcome: "permission-required",
        reason: "terminal-requires-approval",
      };
    }

    return {
      outcome: "allowed",
      result: {
        cwd: request.cwd,
        command: request.command,
      },
    };
  }

  private pathAllowed(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    return this.options.workspaceRoots.some((root) => {
      const resolvedRoot = path.resolve(root);
      const relative = path.relative(resolvedRoot, resolved);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
  }
}
