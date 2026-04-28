import { useEffect, useState } from "react";
import type { RuntimeIdentity } from "../../../shared/runtime-identity";
import type { DesktopApi } from "./desktop-api";

export function useRuntimeIdentity(desktopApi?: DesktopApi): RuntimeIdentity | undefined {
  const [identity, setIdentity] = useState<RuntimeIdentity>();

  useEffect(() => {
    let cancelled = false;

    if (!desktopApi?.getRuntimeIdentity) {
      setIdentity(undefined);
      return () => {
        cancelled = true;
      };
    }

    desktopApi
      .getRuntimeIdentity()
      .then((nextIdentity) => {
        if (!cancelled) {
          setIdentity(nextIdentity);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIdentity(undefined);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [desktopApi]);

  return identity;
}

export function formatRuntimePath(cwd: string): string {
  const segments = workspaceDisplaySegments(cwd);
  const worktreesIndex = segments.lastIndexOf(".worktrees");

  if (worktreesIndex >= 0 && segments[worktreesIndex + 1]) {
    return `.worktrees/${elideMiddle(segments[worktreesIndex + 1], 30)}`;
  }

  const codexWorktreesIndex = segments.lastIndexOf("worktrees");
  if (
    codexWorktreesIndex >= 0 &&
    segments[codexWorktreesIndex - 1] === ".codex" &&
    segments[codexWorktreesIndex + 1] &&
    segments[codexWorktreesIndex + 2]
  ) {
    return `${segments[codexWorktreesIndex + 1]}/${segments[codexWorktreesIndex + 2]}`;
  }

  return segments.slice(-2).join("/") || cwd;
}

function workspaceDisplaySegments(cwd: string): string[] {
  const segments = cwd.split("/").filter(Boolean);
  const desktopAppSuffix = ["apps", "desktop"];

  if (
    segments.length > desktopAppSuffix.length &&
    desktopAppSuffix.every(
      (segment, index) =>
        segments[segments.length - desktopAppSuffix.length + index] === segment
    )
  ) {
    return segments.slice(0, -desktopAppSuffix.length);
  }

  return segments;
}

export function formatRuntimeBranch(branch: string): string {
  return elideMiddle(branch, 34);
}

export function formatRuntimeGitRef(identity: RuntimeIdentity): string | undefined {
  if (identity.detachedHead && identity.commitSha) {
    return "HEAD";
  }

  return identity.branch ? formatRuntimeBranch(identity.branch) : undefined;
}

export function runtimeGitRefCopyValue(identity: RuntimeIdentity): string | undefined {
  if (identity.detachedHead && identity.commitSha) {
    return identity.commitSha;
  }

  return identity.branch;
}

function elideMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const visible = Math.max(8, maxLength - 3);
  const left = Math.ceil(visible / 2);
  const right = Math.floor(visible / 2);
  return `${text.slice(0, left)}...${text.slice(-right)}`;
}
