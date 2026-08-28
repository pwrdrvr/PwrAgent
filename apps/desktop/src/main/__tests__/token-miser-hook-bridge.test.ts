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
  it("derives both descriptor paths from the owning process instance", () => {
    const bridge = new TokenMiserHookBridge({
      stateDir: "/tmp/pwragent-token-miser",
      service: {} as TokenMiserService,
      instanceId: "process-a",
    });

    expect(bridge.bridgeDescriptorPath).toBe(
      path.join(
        "/tmp/pwragent-token-miser",
        "runtimes",
        "process-a",
        "token-miser-bridge-v1.json",
      ),
    );
    expect(bridge.codeModeReducerDescriptorPath).toBe(
      path.join(
        "/tmp/pwragent-token-miser",
        "runtimes",
        "process-a",
        "code-mode-reducer-v1.json",
      ),
    );
  });

  it("writes the closed managed activation descriptor contract", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-managed-descriptor-"),
    );
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: {} as TokenMiserService,
      instanceId: "process-a",
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });

    const descriptor = await bridge.start();

    expect(descriptor).toEqual({
      version: 1,
      identity: "pwrdrvr.pwragent.token-miser",
      activation_nonce: bridge.activationNonce,
      url: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:[0-9]+\/v1\/post-tool-use$/u,
      ),
      acceptance_url: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:[0-9]+\/v1\/accept-code-mode-output$/u,
      ),
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(Buffer.from(bridge.activationNonce, "base64url")).toHaveLength(32);
    if (process.platform !== "win32") {
      expect(
        (await fs.stat(path.dirname(bridge.bridgeDescriptorPath))).mode & 0o777,
      ).toBe(0o700);
      expect((await fs.stat(bridge.bridgeDescriptorPath)).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it("stages an authorized direct replacement and commits only after fork acceptance", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-bridge-"),
    );
    const staged = stagedPostToolUse("replacement", "direct-response-1");
    const preparePostToolUse = vi.fn(async () => staged.prepared);
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: { preparePostToolUse } as unknown as TokenMiserService,
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
          response_id: "direct-response-1",
        },
      },
    });
    expect(preparePostToolUse).toHaveBeenCalledWith(
      payload(),
      { signal: expect.any(AbortSignal) },
    );
    expect(staged.persist).toHaveBeenCalledOnce();
    expect(staged.commit).not.toHaveBeenCalled();

    const reducerDescriptor = await readCodeModeDescriptor(bridge);
    const accepted = await postAcceptance(
      reducerDescriptor,
      directAcceptancePayload("direct-response-1"),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true });
    expect(staged.commit).toHaveBeenCalledOnce();
    expect(staged.discard).not.toHaveBeenCalled();

    const descriptorStats = await fs.stat(bridge.bridgeDescriptorPath);
    // The descriptor carries the bridge's bearer token, so it is written 0o600.
    // Windows does not map POSIX mode bits onto NTFS ACLs — Node reports 0o666
    // whatever mode was requested — so this assertion can only hold off win32.
    // There the token is covered by the ACL inherited from the user profile,
    // which is not something the code sets or this test can observe.
    if (process.platform !== "win32") {
      expect(descriptorStats.mode & 0o077).toBe(0);
    }
  });

  it("skips nested and rejects unversioned direct results before the gate", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-direct-marker-"),
    );
    const preparePostToolUse = vi.fn();
    const captureNestedPostToolUse = vi.fn(async () => {});
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: {
        captureNestedPostToolUse,
        preparePostToolUse,
      } as unknown as TokenMiserService,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    const descriptor = await bridge.start();

    const nested = await postDirectHook(descriptor, {
      ...payload(),
      is_code_mode_nested: true,
      token_miser_grouping_version: 1,
      code_mode_cell_id: "cell-1",
      code_mode_tool_call_id: "nested-1",
    });
    expect(nested.status).toBe(200);
    expect(await nested.json()).toEqual({ hookOutput: null });
    expect(captureNestedPostToolUse).toHaveBeenCalledOnce();
    expect(captureNestedPostToolUse).toHaveBeenCalledWith(expect.objectContaining({
      code_mode_cell_id: "cell-1",
      code_mode_tool_call_id: "nested-1",
      token_miser_grouping_version: 1,
    }));

    captureNestedPostToolUse.mockRejectedValueOnce(new Error("capture failed"));
    const failedCapture = await postDirectHook(descriptor, {
      ...payload(),
      is_code_mode_nested: true,
      token_miser_grouping_version: 1,
      code_mode_cell_id: "cell-1",
      code_mode_tool_call_id: "nested-2",
    });
    expect(failedCapture.status).toBe(200);
    expect(await failedCapture.json()).toEqual({ hookOutput: null });

    const incompleteGrouping = await postDirectHook(descriptor, {
      ...payload(),
      is_code_mode_nested: true,
      token_miser_grouping_version: 1,
      code_mode_cell_id: "cell-1",
    });
    expect(incompleteGrouping.status).toBe(400);

    const unmarked = payload() as Partial<ReturnType<typeof payload>>;
    delete unmarked.is_code_mode_nested;
    const missingMarker = await postDirectHook(descriptor, unmarked);
    expect(missingMarker.status).toBe(400);

    const unversioned = payload() as Partial<ReturnType<typeof payload>>;
    delete unversioned.token_miser_acceptance_version;
    const missingAcceptance = await postDirectHook(descriptor, unversioned);
    expect(missingAcceptance.status).toBe(400);

    const legacyResponseOnly = payload() as Partial<ReturnType<typeof payload>>;
    delete legacyResponseOnly.token_miser_exact_tool_response_version;
    delete legacyResponseOnly.token_miser_exact_tool_response;
    const missingExactOutput = await postDirectHook(
      descriptor,
      legacyResponseOnly,
    );
    expect(missingExactOutput.status).toBe(400);
    expect(preparePostToolUse).not.toHaveBeenCalled();
  });

  it("binds direct acceptance to exact identity and commits duplicates once", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-direct-acceptance-"),
    );
    const staged = stagedPostToolUse("replacement", "direct-response-2");
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: {
        preparePostToolUse: vi.fn(async () => staged.prepared),
      } as unknown as TokenMiserService,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    const descriptor = await bridge.start();
    const reducerDescriptor = await readCodeModeDescriptor(bridge);
    await postDirectHook(descriptor, payload());

    const mismatched = await postAcceptance(reducerDescriptor, {
      ...directAcceptancePayload("direct-response-2"),
      tool_use_id: "different-tool",
    });
    expect(mismatched.status).toBe(404);
    const wrongProtocol = await postAcceptance(
      reducerDescriptor,
      acceptancePayload("direct-response-2"),
    );
    expect(wrongProtocol.status).toBe(404);
    expect(staged.commit).not.toHaveBeenCalled();

    const acceptance = directAcceptancePayload("direct-response-2");
    const concurrent = await Promise.all([
      postAcceptance(reducerDescriptor, acceptance),
      postAcceptance(reducerDescriptor, acceptance),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    const duplicate = await postAcceptance(reducerDescriptor, acceptance);
    expect(duplicate.status).toBe(200);
    expect(staged.commit).toHaveBeenCalledOnce();
    expect(staged.discard).not.toHaveBeenCalled();
  });

  it("discards a direct replacement that Codex never accepts", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-direct-timeout-"),
    );
    const staged = stagedPostToolUse("replacement", "direct-response-3");
    const bridge = new TokenMiserHookBridge({
      stateDir,
      service: {
        preparePostToolUse: vi.fn(async () => staged.prepared),
      } as unknown as TokenMiserService,
      codeModeAcceptanceTimeoutMs: 100,
    });
    cleanups.push(async () => {
      await bridge.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    });
    const descriptor = await bridge.start();

    const response = await postDirectHook(descriptor, payload());
    expect(response.status).toBe(200);
    expect(staged.persist).toHaveBeenCalledOnce();
    expect(staged.commit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(staged.discard).toHaveBeenCalledOnce());
    expect(staged.commit).not.toHaveBeenCalled();
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
      version: 1,
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
    const oversizedIntent = await fetch(descriptor.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify({
        ...codeModePayload(),
        parent_intent: "x".repeat(4_001),
      }),
    });
    expect(oversizedIntent.status).toBe(200);
    expect(await oversizedIntent.json()).toEqual({ replacement: null });
    const actionableState = {
      version: 1,
      entries: [{
        session_id: 101,
        process_id: 101,
        chunk_id: "typecheck-1",
        state: "running",
        exit_code: null,
        required_follow_up: {
          operation: "write_stdin",
          arguments: { session_id: 101, chars: "" },
        },
      }],
    };
    const actionable = await fetch(descriptor.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify({
        ...codeModePayload(),
        actionable_state: actionableState,
      }),
    });
    expect(actionable.status).toBe(200);
    expect(await actionable.json()).toEqual({ replacement: null });
    expect(prepareCodeModeOutput).toHaveBeenCalledOnce();
    expect(prepareCodeModeOutput).toHaveBeenCalledWith(
      expect.objectContaining({ actionable_state: actionableState }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("keeps all same-profile descriptors owned by their bridge instance", async () => {
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
    const [firstDirect, secondDirect] = await Promise.all([
      first.start(),
      second.start(),
    ]);

    expect(first.bridgeDescriptorPath).not.toBe(second.bridgeDescriptorPath);
    expect(first.codeModeReducerDescriptorPath).not.toBe(
      second.codeModeReducerDescriptorPath,
    );
    await expect(
      fs.readFile(first.bridgeDescriptorPath, "utf8"),
    ).resolves.toContain(firstDirect.token);
    await expect(
      fs.readFile(second.bridgeDescriptorPath, "utf8"),
    ).resolves.toContain(secondDirect.token);
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
    await expect(fs.stat(first.bridgeDescriptorPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(first.codeModeReducerDescriptorPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(second.bridgeDescriptorPath)).resolves.toBeDefined();
    await expect(fs.stat(second.codeModeReducerDescriptorPath)).resolves.toBeDefined();
    const secondDirectStillLive = await postDirectHook(secondDirect, {
      unsupported: true,
    });
    expect(secondDirectStillLive.status).toBe(400);
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
      fs.stat(bridge.bridgeDescriptorPath),
    ).rejects.toMatchObject({ code: "ENOENT" });
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
  body:
    | ReturnType<typeof acceptancePayload>
    | ReturnType<typeof directAcceptancePayload>,
): Promise<Response> {
  return await fetch(descriptor.acceptance_url, {
    method: "POST",
    headers: { Authorization: `Bearer ${descriptor.token}` },
    body: JSON.stringify(body),
  });
}

async function postDirectHook(
  descriptor: { url: string; token: string },
  body: unknown,
): Promise<Response> {
  return await fetch(descriptor.url, {
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

function stagedPostToolUse(text: string, objectId: string) {
  const staged = stagedReduction(text, objectId);
  return {
    persist: staged.persist,
    commit: staged.commit,
    discard: staged.discard,
    prepared: {
      hookOutput: {
        continue: false as const,
        stopReason: text,
        hookSpecificOutput: {
          hookEventName: "PostToolUse" as const,
          response_id: objectId,
        },
      },
      responseId: objectId,
      staged: staged.prepared.staged,
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
    is_code_mode_nested: false,
    token_miser_acceptance_version: 1,
    token_miser_exact_tool_response_version: 1,
    parent_intent: "Inspect the exact command output.",
    tool_response: "large output",
    token_miser_exact_tool_response: "large output",
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
    parent_intent: "Find the relevant repository files.",
    script_status: "Script completed",
    max_output_tokens: 10_000,
    model_visible_overhead_characters: 137,
    content_items: [{ type: "input_text", text: "large script output" }],
  };
}

function acceptancePayload(responseId: string) {
  return {
    version: 1,
    response_id: responseId,
    thread_id: "thread-1",
    turn_id: "turn-1",
    call_id: "call-1",
    cell_id: "cell-1",
  };
}

function directAcceptancePayload(responseId: string) {
  return {
    version: 1,
    response_id: responseId,
    session_id: "thread-1",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
  };
}
