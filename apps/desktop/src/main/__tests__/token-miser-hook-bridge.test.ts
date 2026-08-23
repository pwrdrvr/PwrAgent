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

  it("publishes the authenticated v2 reducer and commits only after acceptance", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-reducer-"),
    );
    const staged = stagedReduction(
      "A concise replacement.",
      "token-miser-response-1",
    );
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
    ) as {
      version: number;
      url: string;
      acceptance_url: string;
      token: string;
    };
    expect(descriptor).toMatchObject({
      version: 2,
      url: expect.stringMatching(/\/v1\/reduce-code-mode-output$/),
      acceptance_url: expect.stringMatching(/\/v1\/accept-code-mode-output$/),
    });
    const response = await fetch(descriptor.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify(codeModePayload()),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      replacement: [{ type: "input_text", text: "A concise replacement." }],
      response_id: "token-miser-response-1",
    });
    expect(prepareCodeModeOutput).toHaveBeenCalledWith(
      codeModePayload(),
      { signal: expect.any(AbortSignal) },
    );
    expect(staged.persist).toHaveBeenCalledOnce();
    expect(staged.commit).not.toHaveBeenCalled();
    expect(staged.discard).not.toHaveBeenCalled();

    const accepted = await postAcceptance(
      descriptor,
      acceptancePayload("token-miser-response-1"),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true });
    expect(staged.commit).toHaveBeenCalledOnce();
    expect(staged.discard).not.toHaveBeenCalled();
    const descriptorStats = await fs.stat(descriptorPath);
    if (process.platform !== "win32") {
      expect(descriptorStats.mode & 0o077).toBe(0);
    }
  });

  it("rejects unauthorized, unknown, and mismatched acceptances", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-reducer-"),
    );
    const staged = stagedReduction("replacement", "token-miser-response-2");
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: {
        prepareCodeModeOutput: vi.fn(async () => staged.prepared),
      } as unknown as TokenMiserService,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    await bridge.start();
    const descriptor = await readCodeModeDescriptor(bridge);
    await postReducer(descriptor);

    const unauthorized = await fetch(descriptor.acceptance_url, {
      method: "POST",
      body: JSON.stringify(acceptancePayload("token-miser-response-2")),
    });
    expect(unauthorized.status).toBe(404);

    const unknown = await postAcceptance(
      descriptor,
      acceptancePayload("missing-response"),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "acceptance_not_found" });

    const mismatched = await postAcceptance(descriptor, {
      ...acceptancePayload("token-miser-response-2"),
      turn_id: "different-turn",
    });
    expect(mismatched.status).toBe(404);
    expect(await mismatched.json()).toEqual({ error: "acceptance_not_found" });
    expect(staged.commit).not.toHaveBeenCalled();
    expect(staged.discard).not.toHaveBeenCalled();

    const accepted = await postAcceptance(
      descriptor,
      acceptancePayload("token-miser-response-2"),
    );
    expect(accepted.status).toBe(200);
    expect(staged.commit).toHaveBeenCalledOnce();
  });

  it("commits duplicate and concurrent acceptances exactly once", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-reducer-"),
    );
    const staged = stagedReduction("replacement", "token-miser-response-3");
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: {
        prepareCodeModeOutput: vi.fn(async () => staged.prepared),
      } as unknown as TokenMiserService,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    await bridge.start();
    const descriptor = await readCodeModeDescriptor(bridge);
    await postReducer(descriptor);
    const acceptance = acceptancePayload("token-miser-response-3");

    const concurrent = await Promise.all([
      postAcceptance(descriptor, acceptance),
      postAcceptance(descriptor, acceptance),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    const duplicate = await postAcceptance(descriptor, acceptance);
    expect(duplicate.status).toBe(200);
    expect(staged.commit).toHaveBeenCalledOnce();
    expect(staged.discard).not.toHaveBeenCalled();
  });

  it("discards a persisted reduction when its acceptance times out", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-reducer-"),
    );
    const staged = stagedReduction("replacement", "token-miser-response-4");
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: {
        prepareCodeModeOutput: vi.fn(async () => staged.prepared),
      } as unknown as TokenMiserService,
      codeModeAcceptanceTimeoutMs: 100,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    await bridge.start();
    const descriptor = await readCodeModeDescriptor(bridge);

    await postReducer(descriptor);
    expect(staged.persist).toHaveBeenCalledOnce();
    expect(staged.commit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(staged.discard).toHaveBeenCalledOnce());
    expect(staged.commit).not.toHaveBeenCalled();
  });

  it("discards an unaccepted persisted reduction when the bridge closes", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-reducer-"),
    );
    const staged = stagedReduction("replacement", "token-miser-response-5");
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: {
        prepareCodeModeOutput: vi.fn(async () => staged.prepared),
      } as unknown as TokenMiserService,
      codeModeAcceptanceTimeoutMs: 10_000,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    await bridge.start();
    const descriptor = await readCodeModeDescriptor(bridge);

    await postReducer(descriptor);
    await bridge.close();
    expect(staged.persist).toHaveBeenCalledOnce();
    expect(staged.commit).not.toHaveBeenCalled();
    expect(staged.discard).toHaveBeenCalledOnce();
  });

  it("discards when close races a rejected acceptance commit", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-reducer-"),
    );
    const staged = stagedReduction("replacement", "token-miser-response-6");
    let rejectCommit!: (error: Error) => void;
    staged.commit.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => {
        rejectCommit = reject;
      }),
    );
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: {
        prepareCodeModeOutput: vi.fn(async () => staged.prepared),
      } as unknown as TokenMiserService,
      codeModeAcceptanceTimeoutMs: 10_000,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    await bridge.start();
    const descriptor = await readCodeModeDescriptor(bridge);
    await postReducer(descriptor);
    const acceptance = postAcceptance(
      descriptor,
      acceptancePayload("token-miser-response-6"),
    );
    await vi.waitFor(() => expect(staged.commit).toHaveBeenCalledOnce());

    const closing = bridge.close();
    rejectCommit(new Error("metadata write failed"));
    await expect(acceptance).resolves.toMatchObject({ status: 500 });
    await closing;

    expect(staged.discard).toHaveBeenCalledOnce();
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
    const firstReduction = stagedReduction("first", "first-response");
    const secondReduction = stagedReduction("second", "second-response");
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
      response_id: "first-response",
    });
    await expect(postReducer(secondDescriptor)).resolves.toEqual({
      replacement: [{ type: "input_text", text: "second" }],
      response_id: "second-response",
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
      response_id: "second-response",
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

async function postAcceptance(
  descriptor: { acceptance_url: string; token: string },
  body: ReturnType<typeof acceptancePayload>,
): Promise<Response> {
  return await fetch(descriptor.acceptance_url, {
    method: "POST",
    headers: { Authorization: `Bearer ${descriptor.token}` },
    body: JSON.stringify(body),
  });
}

async function readCodeModeDescriptor(
  bridge: TokenMiserHookBridge,
): Promise<{
  version: number;
  url: string;
  acceptance_url: string;
  token: string;
}> {
  return JSON.parse(
    await fs.readFile(bridge.codeModeReducerDescriptorPath, "utf8"),
  ) as {
    version: number;
    url: string;
    acceptance_url: string;
    token: string;
  };
}

function stagedReduction(text: string, objectId: string) {
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
        response_id: objectId,
      },
      staged: {
        metadata: { objectId } as never,
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
    version: 2,
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

function acceptancePayload(responseId: string) {
  return {
    version: 2,
    response_id: responseId,
    thread_id: "thread-1",
    turn_id: "turn-1",
    call_id: "call-1",
    cell_id: "cell-1",
  };
}
