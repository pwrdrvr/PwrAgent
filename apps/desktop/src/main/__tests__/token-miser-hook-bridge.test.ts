import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenMiserHookBridge } from "../token-miser/token-miser-hook-bridge";
import type { TokenMiserService } from "../token-miser/token-miser-service";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("TokenMiserHookBridge", () => {
  it("requires its bearer token and returns a replacement to an authorized hook", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-bridge-"),
    );
    const handlePostToolUse = vi.fn(async () => ({
      continue: false as const,
      stopReason: "replacement",
      hookSpecificOutput: {
        hookEventName: "PostToolUse" as const,
        additionalContext: "replacement",
      },
    }));
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: { handlePostToolUse } as unknown as TokenMiserService,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    const descriptor = await bridge.start();

    const unauthorized = await fetch(descriptor.url, {
      method: "POST",
      body: JSON.stringify(payload()),
    });
    expect(unauthorized.status).toBe(404);

    const authorized = await fetch(descriptor.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify(payload()),
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      hookOutput: {
        continue: false,
        stopReason: "replacement",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "replacement",
        },
      },
    });
    expect(handlePostToolUse).toHaveBeenCalledOnce();

    const descriptorStats = await fs.stat(path.join(stateDir, "bridge.json"));
    // The descriptor carries the bridge's bearer token, so it is written 0o600.
    // Windows does not map POSIX mode bits onto NTFS ACLs — Node reports 0o666
    // whatever mode was requested — so this assertion can only hold off win32.
    // There the token is covered by the ACL inherited from the user profile,
    // which is not something the code sets or this test can observe.
    if (process.platform !== "win32") {
      expect(descriptorStats.mode & 0o077).toBe(0);
    }
  });
});

function payload() {
  return {
    session_id: "thread-1",
    turn_id: "turn-1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_response: "large output",
  };
}
