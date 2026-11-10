import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { canonicalDurableSteerRequest, canonicalDurableTurnRequest, type SubmitDurableSteerRequest, type SubmitDurableTurnRequest } from "@pwragent/shared";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { startOutpostDaemon } from "../src/main/__tests__/helpers/outpost-daemon";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test.beforeAll(() => {
  // The production JS imports Outpost's published bundle. A desktop-only
  // build does not produce it in a clean checkout.
  execFileSync(process.execPath, [path.resolve(specDir, "../../../packages/pwragent/scripts/build.mjs")], {
    cwd: path.resolve(specDir, "../../.."), stdio: "pipe",
  });
});

test("ordinary and explicitly retried Outpost guidance preserve the mounted native owner and distinct waiting turn", async () => {
  test.skip(process.platform === "win32", "The executable Outpost Runtime supports Linux and macOS");
  test.setTimeout(120_000);
  const outpost = await startOutpostDaemon({ packageRoot: path.resolve(specDir, "../../../packages/pwragent") });
  const command = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, [outpost.cli, ...args], { env: outpost.env })).stdout);
  const displaced = `${outpost.workspace}-unavailable`;
  let workspaceDisplaced = false;
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    const created = await outpost.client.startThread({ backend: "codex", cwd: outpost.workspace });
    const identity = { backend: "codex" as const, threadId: created.threadId };
    await outpost.client.renameThread({ ...identity, name: "Invented ordinary steering" });
    const active = await outpost.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const invite = await command(["federation-invite", "--port", "0"]);
    app = await launchElectronApp({ secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json") });
    await app.window.evaluate(async encoded => {
      await (window as unknown as { pwragent: DesktopApi }).pwragent.importFederationInvite!({ invite: encoded });
    }, invite.invite);
    await expect.poll(async () => app!.window.evaluate(async () =>
      (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health.status)).toBe("connected");
    await app.window.evaluate(async ({ instanceId, threadId }) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const ref = { backend: "codex" as const, threadId, target: { scope: "remote" as const, instanceId } };
      await api.addRemoteThreadPin!({ ref, instanceLabel: "Invented Outpost", summary: {
        id: threadId, source: "codex", title: "Invented ordinary steering", titleSource: "explicit", linkedDirectories: [],
        threadStatus: "active", inbox: { inInbox: true }, updatedAt: 2_000,
        federation: { ref, instanceLabel: "Invented Outpost", peerStatus: "connected" },
      } });
    }, { instanceId: outpost.ownerInstanceId, threadId: identity.threadId });
    await app.window.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: "Invented ordinary steering", exact: true }).click();
    const thinking = app.window.getByRole("img", { name: "Thinking on another instance", exact: true });
    await expect(thinking).toHaveCount(1);
    const request = { ...identity, queueEntryId: "mounted-guidance", input: [{ type: "text" as const, text: "Invented ordinary interjection" }],
      messageOrigin: { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "invented-sender", instanceId: "forged" } } };
    const accepted = await outpost.client.startTurn(request);
    await expect.poll(async () => (await command(["show", "--id", accepted.queueEntryId!])).status).toBe("running");
    const job = await command(["show", "--id", accepted.queueEntryId!]);
    // Hold a second acknowledgement so the next accepted entry can be paused
    // before making its test-owned project unavailable. No native work is
    // accepted for that next entry until the operator explicitly retries it.
    await outpost.client.startTurn({ ...request, queueEntryId: "ack-gate", input: [{ type: "text", text: "hold-steer-ack" }] });
    await expect.poll(async () => readFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "steer.ready"), "utf8").then(() => true, () => false)).toBe(true);
    const heldRequest = { ...request, queueEntryId: "mounted-held-guidance", input: [{ type: "text" as const, text: "Invented held guidance Retry" }] };
    const held = await outpost.client.startTurn(heldRequest);
    await command(["pause", "--id", held.queueEntryId!]);
    await rename(outpost.workspace, displaced); workspaceDisplaced = true;
    await writeFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "steer.release"), "release");
    await command(["resume", "--id", held.queueEntryId!]);
    const heldRow = app.window.locator(".composer__queued").filter({ hasText: heldRequest.input[0].text });
    const retry = heldRow.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    const beforeRetry = await command(["show", "--id", held.queueEntryId!]);
    expect(beforeRetry.status).toBe("queued");
    expect(beforeRetry.turnId).toBeUndefined();
    await rename(displaced, outpost.workspace); workspaceDisplaced = false;
    await expect(retry).toBeEnabled();
    const screenshots = path.resolve(specDir, "../../../.local");
    await mkdir(screenshots, { recursive: true });
    await app.window.screenshot({ path: path.join(screenshots, "held-steer-before-retry.png") });
    await retry.click();
    await expect(heldRow).toHaveCount(0);
    await app.window.screenshot({ path: path.join(screenshots, "held-steer-after-retry.png") });
    expect(await command(["show", "--id", held.queueEntryId!])).toMatchObject({ status: "running", turnId: active.turnId, fingerprint: beforeRetry.fingerprint });
    expect((await outpost.client.startTurn(heldRequest)).queueEntryId).toBe(held.queueEntryId);
    expect(await outpost.client.releaseQueuedTurn({ queueEntryId: held.queueEntryId! })).toMatchObject({ disposition: "not_found" });
    const waiting = await outpost.client.startTurn({ ...identity, delivery: "new_turn", input: [{ type: "text", text: "Invented distinct waiting turn" }] });
    const first = await outpost.client.startTurn({ ...request, queueEntryId: "mounted-first", input: [{ type: "text", text: "Invented first waiting guidance" }] });
    const second = await outpost.client.startTurn({ ...request, queueEntryId: "mounted-second", input: [{ type: "text", text: "Invented second waiting guidance" }] });
    const original = await command(["show", "--id", first.queueEntryId!]);
    const replacement = await outpost.client.replaceQueuedMessage({ ...identity, queueEntryId: first.queueEntryId!,
      input: [{ type: "text", text: "Invented replacement guidance" }], messageOrigin: request.messageOrigin });
    expect(replacement.queueEntryId).not.toBe(first.queueEntryId);
    expect((await outpost.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.map(entry => entry.queueEntryId))
      .toEqual([waiting.queueEntryId, replacement.queueEntryId, second.queueEntryId]);
    expect(await command(["show", "--id", first.queueEntryId!])).toMatchObject({ status: "interrupted", fingerprint: original.fingerprint });
    const queued = app.window.locator(".composer__queued").filter({ hasText: "Invented distinct waiting turn" });
    await expect(queued).toHaveCount(1);
    const replaced = app.window.locator(".composer__queued").filter({ hasText: "Invented replacement guidance" });
    await expect(replaced).toHaveCount(1);
    for (let i = 0; i < 8; i++) expect((await outpost.client.startTurn(request)).queueEntryId).toBe(accepted.queueEntryId);
    await expect(thinking).toHaveCount(1);
    await expect(queued).toHaveCount(1);
    expect(await outpost.client.resolveThreadAdmissionState(identity)).toMatchObject({ activeTurn: { turnId: active.turnId } });
    await outpost.client.interruptTurn(active);
    await expect(queued).toHaveCount(0);
    await expect(replaced).toHaveCount(0);
    await expect(thinking).toHaveCount(0);
    expect(await command(["show", "--id", accepted.queueEntryId!])).toMatchObject({ status: "interrupted", fingerprint: job.fingerprint, turnId: active.turnId });
    const calls = (await readFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const steers = calls.filter(call => call.method === "turn/steer" && call.params.input[0].text === request.input[0].text);
    expect(steers).toHaveLength(1);
    expect(steers[0].params).toMatchObject({ expectedTurnId: active.turnId, input: request.input });
    const activeTurnSteers = calls.filter(call => call.method === "turn/steer" && call.params.expectedTurnId === active.turnId);
    expect(activeTurnSteers).toHaveLength(3);
    expect(activeTurnSteers.filter(call => call.params.input[0].text === heldRequest.input[0].text)).toHaveLength(1);
    expect(steers.every(call => call.params.expectedTurnId === active.turnId)).toBe(true);
    expect(calls.filter(call => call.method === "turn/start" && call.params.input[0].text === request.input[0].text)).toHaveLength(0);
    expect(calls.filter(call => call.method === "turn/start" && call.params.input[0].text === "Invented distinct waiting turn")).toHaveLength(1);
    const inputs = calls.filter(call => call.method === "turn/start" || call.method === "turn/steer").map(call => call.params.input[0].text);
    expect(inputs).not.toContain("Invented first waiting guidance");
    expect(inputs.filter(text => text === "Invented replacement guidance" || text === "Invented second waiting guidance"))
      .toEqual(["Invented replacement guidance", "Invented second waiting guidance"]);
    expect((await outpost.client.startTurn(request)).queueEntryId).toBe(accepted.queueEntryId);
    expect((await outpost.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
    expect(waiting.queueEntryId).not.toBe(accepted.queueEntryId);
  } finally {
    if (workspaceDisplaced) await rename(displaced, outpost.workspace);
    try { await app?.close(); } finally { await outpost.close(); }
  }
});

test("durable Outpost steering delivers once to the mounted active turn while its waiting queue stays intact", async () => {
  test.skip(process.platform === "win32", "The executable Outpost Runtime supports Linux and macOS");
  test.setTimeout(120_000);
  const outpost = await startOutpostDaemon({ packageRoot: path.resolve(specDir, "../../../packages/pwragent") });
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    const identity = await outpost.client.startThread({ backend: "codex", cwd: outpost.workspace });
    await outpost.client.renameThread({ ...identity, name: "Invented durable steering" });
    const active = await outpost.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const waiting = await outpost.client.startTurn({ ...identity, input: [{ type: "text", text: "Invented waiting input" }] });
    const invite = JSON.parse((await promisify(execFile)(process.execPath, [outpost.cli, "federation-invite", "--port", "0"], { env: outpost.env })).stdout);
    app = await launchElectronApp({ secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json") });
    await app.window.evaluate(async encoded => {
      await (window as unknown as { pwragent: DesktopApi }).pwragent.importFederationInvite!({ invite: encoded });
    }, invite.invite);
    await expect.poll(async () => app!.window.evaluate(async () =>
      (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health.status)).toBe("connected");
    await app.window.evaluate(async ({ instanceId, threadId }) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const ref = { backend: "codex" as const, threadId, target: { scope: "remote" as const, instanceId } };
      await api.addRemoteThreadPin!({ ref, instanceLabel: "Invented Outpost", summary: {
        id: threadId, source: "codex", title: "Invented durable steering", titleSource: "explicit", linkedDirectories: [],
        threadStatus: "active", inbox: { inInbox: true }, updatedAt: 2_000,
        federation: { ref, instanceLabel: "Invented Outpost", peerStatus: "connected" },
      } });
    }, { instanceId: outpost.ownerInstanceId, threadId: identity.threadId });
    await app.window.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: "Invented durable steering", exact: true }).click();
    const queued = app.window.locator(".composer__queued").filter({ hasText: "Invented waiting input" });
    const thinking = app.window.getByRole("img", { name: "Thinking on another instance", exact: true });
    await expect(queued).toHaveCount(1);
    await expect(thinking).toHaveCount(1);
    expect(await outpost.client.resolveThreadAdmissionState({ backend: "codex", threadId: identity.threadId })).toMatchObject({ activeTurn: {
      backend: "codex", threadId: identity.threadId, turnId: active.turnId,
    } });
    const request: SubmitDurableSteerRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
      request: { backend: "codex", threadId: identity.threadId, expectedTurnId: active.turnId, input: [{ type: "text", text: "Invented durable interjection" }] } };
    request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableSteerRequest(outpost.ownerInstanceId, request)).digest("hex");
    const receipts = await Promise.all(Array.from({ length: 8 }, () => outpost.client.submitSteerRequest(request)));
    const receipt = await outpost.client.getSteerRequest({ backend: "codex", threadId: identity.threadId, id: request.clientRequest.id });
    expect(receipt).toMatchObject({ state: "dispatched", operation: "steerTurn", result: { ok: true, turnId: active.turnId, requestId: receipt!.queueEntryId } });
    expect(receipts.every(result => result.queueEntryId === receipt!.queueEntryId)).toBe(true);
    await expect(queued).toHaveCount(1);
    await expect(thinking).toHaveCount(1);
    expect(await outpost.client.resolveThreadAdmissionState({ backend: "codex", threadId: identity.threadId })).toMatchObject({ activeTurn: {
      backend: "codex", threadId: identity.threadId, turnId: active.turnId,
    } });
    expect((await outpost.client.getNavigationQueueProjection({ protocol: 2, ref: { backend: "codex", threadId: identity.threadId } })).entries.map(entry => entry.queueEntryId)).toEqual([waiting.queueEntryId]);
    await outpost.client.interruptTurn(active);
    await expect(queued).toHaveCount(0);
    await expect(thinking).toHaveCount(0);
    expect(await outpost.client.submitSteerRequest(request)).toEqual(receipt);
    const calls = (await readFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const steers = calls.filter(call => call.method === "turn/steer");
    expect(steers).toHaveLength(1);
    expect(steers[0].params).toMatchObject({ threadId: identity.threadId, expectedTurnId: active.turnId, input: request.request.input });
    expect(calls.filter(call => call.method === "turn/start" && call.params.input[0].text === "Invented waiting input")).toHaveLength(1);
  } finally {
    try { await app?.close(); } finally { await outpost.close(); }
  }
});

test("durable Outpost admission appears in the mounted queue and cancelled input needs a new receipt before one send", async () => {
  test.skip(process.platform === "win32", "The executable Outpost Runtime supports Linux and macOS");
  test.setTimeout(120_000);
  const outpost = await startOutpostDaemon({ packageRoot: path.resolve(specDir, "../../../packages/pwragent") });
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    const identity = await outpost.client.startThread({ backend: "codex", cwd: outpost.workspace });
    await outpost.client.renameThread({ ...identity, name: "Invented durable queue" });
    const active = await outpost.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const submission = (text: string): SubmitDurableTurnRequest => {
      const value: SubmitDurableTurnRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
        request: { backend: "codex", threadId: identity.threadId, input: [{ type: "text", text }] } };
      value.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(outpost.ownerInstanceId, value)).digest("hex");
      return value;
    };
    const request = submission("Invented durable original"), original = await outpost.client.submitTurnRequest(request);
    const invite = JSON.parse((await promisify(execFile)(process.execPath, [outpost.cli, "federation-invite", "--port", "0"], { env: outpost.env })).stdout);
    app = await launchElectronApp({ secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json") });
    await app.window.evaluate(async encoded => {
      await (window as unknown as { pwragent: DesktopApi }).pwragent.importFederationInvite!({ invite: encoded });
    }, invite.invite);
    await expect.poll(async () => app!.window.evaluate(async () =>
      (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health.status)).toBe("connected");
    await app.window.evaluate(async ({ instanceId, threadId }) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const ref = { backend: "codex" as const, threadId, target: { scope: "remote" as const, instanceId } };
      await api.addRemoteThreadPin!({ ref, instanceLabel: "Invented Outpost", summary: {
        id: threadId, source: "codex", title: "Invented durable queue", titleSource: "explicit", linkedDirectories: [],
        threadStatus: "active", inbox: { inInbox: true }, updatedAt: 2_000,
        federation: { ref, instanceLabel: "Invented Outpost", peerStatus: "connected" },
      } });
    }, { instanceId: outpost.ownerInstanceId, threadId: identity.threadId });
    await app.window.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: "Invented durable queue", exact: true }).click();
    const queued = app.window.locator(".composer__queued");
    await expect(queued.filter({ hasText: "Invented durable original" })).toHaveCount(1);
    for (let n = 0; n < 5; n++) expect((await outpost.client.submitTurnRequest(request)).queueEntryId).toBe(original.queueEntryId);
    await outpost.client.cancelQueuedTurn({ queueEntryId: original.queueEntryId });
    expect(await outpost.client.getTurnRequest({ backend: "codex", threadId: identity.threadId, id: request.clientRequest.id })).toMatchObject({ state: "completed", outcome: "cancelled" });
    await expect(queued.filter({ hasText: "Invented durable original" })).toHaveCount(0);
    const changed = submission("Invented durable changed"), replacement = await outpost.client.submitTurnRequest(changed);
    expect(replacement.queueEntryId).not.toBe(original.queueEntryId);
    await expect(queued.filter({ hasText: "Invented durable changed" })).toHaveCount(1);
    await outpost.client.interruptTurn(active);
    await expect.poll(() => outpost.client.getTurnRequest({ backend: "codex", threadId: identity.threadId, id: changed.clientRequest.id })).toMatchObject({ state: "completed", outcome: "completed" });
    await expect(queued.filter({ hasText: "Invented durable changed" })).toHaveCount(0);
    const calls = (await readFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === "turn/start" && call.params.input[0].text === "Invented durable original")).toHaveLength(0);
    expect(calls.filter(call => call.method === "turn/start" && call.params.input[0].text === "Invented durable changed")).toHaveLength(1);
  } finally {
    try { await app?.close(); } finally { await outpost.close(); }
  }
});

test("an authenticated queued replacement reaches the mounted desktop with a new durable identity and one provider send", async () => {
  test.skip(process.platform === "win32", "The executable Outpost Runtime supports Linux and macOS");
  test.setTimeout(120_000);
  const outpost = await startOutpostDaemon({ packageRoot: path.resolve(specDir, "../../../packages/pwragent") });
  const command = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, [outpost.cli, ...args], { env: outpost.env })).stdout);
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    const identity = await outpost.client.startThread({ backend: "codex", cwd: outpost.workspace });
    await outpost.client.renameThread({ ...identity, name: "Invented queued replacement" });
    const active = await outpost.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const messageOrigin = { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "invented-sender", instanceId: "forged" } };
    const originalText = "Invented original agent input", changedText = "Invented consolidated agent input";
    const followupText = "Invented follow-up after consolidated input";
    const original = await outpost.client.startTurn({ ...identity, input: [{ type: "text", text: originalText }], messageOrigin });
    const followup = await outpost.client.startTurn({ ...identity, input: [{ type: "text", text: followupText }] });
    const accepted = await command(["show", "--id", original.queueEntryId!]);
    const invite = await command(["federation-invite", "--port", "0"]);
    app = await launchElectronApp({ secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json") });
    await app.window.evaluate(async encoded => {
      await (window as unknown as { pwragent: DesktopApi }).pwragent.importFederationInvite!({ invite: encoded });
    }, invite.invite);
    await expect.poll(async () => app!.window.evaluate(async () =>
      (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health.status)).toBe("connected");
    await app.window.evaluate(async ({ instanceId, threadId }) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const ref = { backend: "codex" as const, threadId, target: { scope: "remote" as const, instanceId } };
      await api.addRemoteThreadPin!({ ref, instanceLabel: "Invented Outpost", summary: {
        id: threadId, source: "codex", title: "Invented queued replacement", titleSource: "explicit", linkedDirectories: [],
        threadStatus: "active", inbox: { inInbox: true }, updatedAt: 2_000,
        federation: { ref, instanceLabel: "Invented Outpost", peerStatus: "connected" },
      } });
    }, { instanceId: invite.instanceId, threadId: identity.threadId });
    await app.window.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: "Invented queued replacement", exact: true }).click();
    await expect(app.window.locator(".composer__queued").filter({ hasText: originalText })).toHaveCount(1);
    const replacement = await outpost.client.replaceQueuedMessage({ ...identity, queueEntryId: original.queueEntryId!, input: [{ type: "text", text: changedText }], messageOrigin });
    expect(replacement.queueEntryId).not.toBe(original.queueEntryId);
    await expect(app.window.locator(".composer__queued").filter({ hasText: originalText })).toHaveCount(0);
    await expect(app.window.locator(".composer__queued").filter({ hasText: changedText })).toHaveCount(1);
    expect((await outpost.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.map(entry => entry.queueEntryId))
      .toEqual([replacement.queueEntryId, followup.queueEntryId]);
    expect(await command(["show", "--id", original.queueEntryId!])).toMatchObject({ status: "interrupted", fingerprint: accepted.fingerprint });
    expect(await command(["show", "--id", replacement.queueEntryId!])).toMatchObject({ status: "queued", messageOrigin: { sourceThread: { instanceId: outpost.viewerId } } });
    await outpost.client.interruptTurn(active);
    expect((await command(["wait", "--id", replacement.queueEntryId!])).status).toBe("completed");
    expect((await command(["wait", "--id", followup.queueEntryId!])).status).toBe("completed");
    await expect(app.window.locator(".composer__queued").filter({ hasText: changedText })).toHaveCount(0);
    const calls = (await readFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === "turn/start" && call.params.input[0].text === originalText)).toHaveLength(0);
    expect(calls.filter(call => call.method === "turn/start" && call.params.input[0].text === changedText)).toHaveLength(1);
    expect(calls.filter(call => call.method === "turn/start" && call.params.threadId === identity.threadId)
      .map(call => call.params.input[0].text).filter(text => text === changedText || text === followupText)).toEqual([changedText, followupText]);
  } finally { await app?.close(); await outpost.close(); }
});

test("a real Outpost queued message becomes a private viewer draft before edited input gets a new acceptance", async () => {
  test.skip(process.platform === "win32", "The executable Outpost Runtime supports Linux and macOS");
  test.setTimeout(120_000);
  const root = realpathSync(await mkdtemp("/tmp/pa-edit-"));
  const packageRoot = path.resolve(specDir, "../../../packages/pwragent");
  const cli = path.join(packageRoot, "bin/pwragent.js");
  const workspace = path.join(root, "w"), home = path.join(root, "c"), data = path.join(root, "f");
  for (const directory of [workspace, home, data]) await mkdir(directory);
  const env = { ...process.env, PWRAGENT_HOME: root, PWRAGENT_PROFILE: "t", PWRAGENT_TEST_DATA: data };
  const daemon = spawn(process.execPath, [cli, "serve", "--workspace", workspace, "--codex-home", home,
    "--codex-bin", path.join(packageRoot, "test/fixtures/codex.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => daemon.once("exit", resolve));
  const command = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, [cli, ...args], { env })).stdout);
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "", errors = "";
      daemon.stdout.on("data", chunk => { output += String(chunk); if (output.includes('"ready":true')) resolve(); });
      daemon.stderr.on("data", chunk => { errors += String(chunk); });
      daemon.once("error", reject);
      daemon.once("exit", () => reject(new Error(`Outpost stopped before readiness: ${errors}`)));
    });
    const promptFile = path.join(root, "input.txt");
    await writeFile(promptFile, "slow");
    await command(["submit", "--id", "active", "--prompt-file", promptFile]);
    await expect.poll(async () => (await command(["show", "--id", "active"])).status).toBe("running");
    const threadId = (await command(["show", "--id", "active"])).threadId;
    const prompt = `${"Invented queued Ω text beyond the preview. ".repeat(12)}Private edit tail.`;
    await writeFile(promptFile, prompt);
    const accepted = await command(["submit", "--id", "original", "--thread", threadId, "--prompt-file", promptFile]);
    expect(accepted.status).toBe("queued");
    const invite = await command(["federation-invite", "--port", "0"]);
    app = await launchElectronApp({ secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json") });
    await app.window.evaluate(async encoded => {
      await (window as unknown as { pwragent: DesktopApi }).pwragent.importFederationInvite!({ invite: encoded });
    }, invite.invite);
    await expect.poll(async () => app!.window.evaluate(async () =>
      (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health.status)).toBe("connected");
    await app.window.evaluate(async ({ instanceId, threadId }) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const target = { scope: "remote" as const, instanceId };
      await api.renameThread!({ backend: "codex", threadId, name: "Outpost queued edit", federationTarget: target });
      const ref = { backend: "codex" as const, threadId, target };
      await api.addRemoteThreadPin!({ ref, instanceLabel: "Invented Outpost", summary: {
        id: threadId, source: "codex", title: "Outpost queued edit", titleSource: "explicit", linkedDirectories: [],
        threadStatus: "active", inbox: { inInbox: true }, updatedAt: 2_000,
        federation: { ref, instanceLabel: "Invented Outpost", peerStatus: "connected" },
      } });
    }, { instanceId: invite.instanceId, threadId });
    await app.window.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: "Outpost queued edit", exact: true }).click();
    const queued = app.window.locator(".composer__queued").filter({ hasText: "Invented queued Ω text" });
    await expect(queued).toHaveCount(1);
    await queued.getByRole("button", { name: "Edit", exact: true }).click();
    const reply = app.window.getByLabel("Reply", { exact: true });
    await expect(reply).toHaveText(prompt);
    await expect(queued).toHaveCount(0);
    expect(await command(["show", "--id", "original"])).toMatchObject({ status: "interrupted", fingerprint: accepted.fingerprint });
    const edited = `${prompt} Locally changed.`;
    await reply.fill(edited);
    expect((await command(["list"])).map((job: { id: string }) => job.id).sort()).toEqual(["active", "original"]);
    expect(await readFile(path.join(data, "calls.jsonl"), "utf8")).not.toContain("Locally changed.");
    await app.window.locator(".composer__send-submit-button").click();
    await expect.poll(async () => (await command(["list"])).length).toBe(3);
    const replacement = (await command(["list"])).find((job: { id: string }) => !["active", "original"].includes(job.id));
    expect(replacement).toMatchObject({ status: "queued", threadId });
    expect(replacement.fingerprint).not.toBe(accepted.fingerprint);
    await command(["interrupt", "--id", "active"]);
    expect((await command(["wait", "--id", replacement.id])).status).toBe("completed");
    const calls = (await readFile(path.join(data, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === "turn/start" && call.params.input[0].text === prompt)).toHaveLength(0);
    expect(calls.filter(call => call.method === "turn/start" && call.params.input[0].text === edited)).toHaveLength(1);
  } finally {
    await app?.close();
    daemon.kill("SIGTERM"); await exited;
    await rm(root, { recursive: true, force: true });
  }
});
