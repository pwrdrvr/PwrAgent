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

  it("publishes an authenticated code-mode reducer and forwards protocol v1", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-reducer-"),
    );
    const staged = stagedReduction("A concise replacement.");
    const prepareCodeModeOutput = vi.fn(async () => staged.prepared);
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: { prepareCodeModeOutput } as unknown as TokenMiserService,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    await bridge.start();

    const descriptorPath = bridge.codeModeReducerDescriptorPath;
    const descriptor = JSON.parse(
      await fs.readFile(descriptorPath, "utf8"),
    ) as { version: number; url: string; token: string };
    expect(descriptor).toMatchObject({
      version: 1,
      url: expect.stringMatching(/\/v1\/reduce-code-mode-output$/),
    });
    const response = await fetch(descriptor.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify(codeModePayload()),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      replacement: [{ type: "input_text", text: "A concise replacement." }],
    });
    expect(prepareCodeModeOutput).toHaveBeenCalledWith(
      codeModePayload(),
      { signal: expect.any(AbortSignal) },
    );
    expect(staged.persist).toHaveBeenCalledOnce();
    expect(staged.commit).toHaveBeenCalledOnce();
    expect(staged.discard).not.toHaveBeenCalled();
    const descriptorStats = await fs.stat(descriptorPath);
    if (process.platform !== "win32") {
      expect(descriptorStats.mode & 0o077).toBe(0);
    }
  });

  it("fails open without invoking the gate for unsupported content items", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-reducer-"),
    );
    const prepareCodeModeOutput = vi.fn();
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: { prepareCodeModeOutput } as unknown as TokenMiserService,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    await bridge.start();
    const descriptor = JSON.parse(
      await fs.readFile(bridge.codeModeReducerDescriptorPath, "utf8"),
    ) as { url: string; token: string };
    const response = await fetch(descriptor.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify({
        ...codeModePayload(),
        content_items: [{
          type: "input_image",
          image_url: "data:image/png;base64,abc",
        }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ replacement: null });
    const futureShape = await fetch(descriptor.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify({
        ...codeModePayload(),
        source_tool_name: "shell",
      }),
    });
    expect(futureShape.status).toBe(200);
    expect(await futureShape.json()).toEqual({ replacement: null });
    expect(prepareCodeModeOutput).not.toHaveBeenCalled();
  });

  it("keeps same-profile reducer descriptors owned by their bridge instance", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-multi-bridge-"),
    );
    const firstReduction = stagedReduction("first");
    const secondReduction = stagedReduction("second");
    const firstHandler = vi.fn(async () => firstReduction.prepared);
    const secondHandler = vi.fn(async () => secondReduction.prepared);
    const first = new TokenMiserHookBridge({
      stateDir,
      service: {
        prepareCodeModeOutput: firstHandler,
      } as unknown as TokenMiserService,
    });
    const second = new TokenMiserHookBridge({
      stateDir,
      service: {
        prepareCodeModeOutput: secondHandler,
      } as unknown as TokenMiserService,
    });
    cleanups.push(async () => {
      await Promise.all([first.close(), second.close()]);
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    await Promise.all([first.start(), second.start()]);

    expect(first.codeModeReducerDescriptorPath).not.toBe(
      second.codeModeReducerDescriptorPath,
    );
    const firstDescriptor = JSON.parse(
      await fs.readFile(first.codeModeReducerDescriptorPath, "utf8"),
    ) as { url: string; token: string };
    const secondDescriptor = JSON.parse(
      await fs.readFile(second.codeModeReducerDescriptorPath, "utf8"),
    ) as { url: string; token: string };

    await expect(postReducer(firstDescriptor)).resolves.toEqual({
      replacement: [{ type: "input_text", text: "first" }],
    });
    await expect(postReducer(secondDescriptor)).resolves.toEqual({
      replacement: [{ type: "input_text", text: "second" }],
    });
    expect(firstHandler).toHaveBeenCalledOnce();
    expect(secondHandler).toHaveBeenCalledOnce();

    await first.close();
    await expect(fs.stat(first.codeModeReducerDescriptorPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(second.codeModeReducerDescriptorPath)).resolves.toBeDefined();
    await expect(postReducer(secondDescriptor)).resolves.toEqual({
      replacement: [{ type: "input_text", text: "second" }],
    });
    expect(secondHandler).toHaveBeenCalledTimes(2);
  });

  it("serializes close against an in-flight start", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-start-close-"),
    );
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: {} as TokenMiserService,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });

    const starting = bridge.start();
    const closing = bridge.close();
    const descriptor = await starting;
    await closing;

    await expect(
      fs.stat(bridge.codeModeReducerDescriptorPath),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch(descriptor.url)).rejects.toThrow();

    const restarted = await bridge.start();
    expect(restarted.url).not.toBe(descriptor.url);
  });
});

async function postReducer(descriptor: {
  url: string;
  token: string;
}): Promise<unknown> {
  const response = await fetch(descriptor.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${descriptor.token}` },
    body: JSON.stringify(codeModePayload()),
  });
  expect(response.status).toBe(200);
  return await response.json();
}

function stagedReduction(text: string) {
  const persist = vi.fn(async () => {});
  const commit = vi.fn(async () => {});
  const discard = vi.fn(async () => {});
  return {
    persist,
    commit,
    discard,
    prepared: {
      response: {
        replacement: [{ type: "input_text" as const, text }],
      },
      staged: {
        metadata: {} as never,
        persist,
        commit,
        discard,
      },
    },
  };
}

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

function codeModePayload() {
  return {
    version: 1,
    thread_id: "thread-1",
    turn_id: "turn-1",
    call_id: "call-1",
    cell_id: "cell-1",
    script: "text(await tools.exec_command({ cmd: 'rg --files' }))",
    script_status: "Script completed",
    max_output_tokens: 10_000,
    content_items: [{ type: "input_text", text: "large script output" }],
  };
}
