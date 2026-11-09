import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { canonicalDurableSteerRequest, canonicalDurableTurnRequest, type SubmitDurableSteerRequest, type SubmitDurableTurnRequest } from "@pwragent/shared";
import { openOutpostProfileRuntime } from "../../../packages/pwragent/src/federation-core";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import type { AppServerThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { seedRetainedOutpostUnreadThread } from "./fixtures/outpost-owner-data-seeding";
import { startOutpostDaemon } from "../src/main/__tests__/helpers/outpost-daemon";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.resolve(specDir, "../../../packages/pwragent/src", file)).href);

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

test("actual Outpost held, paused and ordered queue controls hand durable outcomes to desktop without replay", async () => {
  test.skip(process.platform === "win32", "The executable Outpost Runtime supports Linux and macOS");
  const [{ JobStore }, { Runtime }, { HeadlessFederation }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation.js")]);
  const ref = { backend: "codex" as const, threadId: "thread-smoke" };
  let headless = "";
  let fingerprint = "";
  const app = await launchElectronApp({
    secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const workspace = realpathSync(homeRoot);
      const stateDirectory = path.dirname(stateDbPathForHomeRoot(homeRoot));
      headless = path.join(stateDirectory, "headless");
      const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: workspace });
      try {
        const store = new JobStore(headless, { version: 1, workspace, codexHome: path.join(homeRoot, "codex") }, profile);
        const runtime = new Runtime({ workspace, store, home: path.join(homeRoot, "codex"), command: "unused", onFailure() {} });
        let sends = 0;
        runtime.codex = { startTurn: async ({ threadId }: { threadId: string }) => {
          if (++sends === 2) throw new Error("Invented native refusal");
          return { threadId, turnId: `queue-turn-${sends}` };
        }, stop: async () => {} };
        const backend = new HeadlessFederation({ directory: headless, runtime, profile: "default", onFailure() {} }).backend;
        runtime.onEvent = (event: unknown) => backend.event(event);
        backend.persistCreatedNativeThread({ id: ref.threadId, cwd: workspace, title: "Replay smoke thread", titleSource: "explicit", createdAt: Date.now() });
        runtime.submit({ id: "queue-first", threadId: ref.threadId, prompt: "Invented first input" });
        await runtime.work;
        const messageOrigin = { kind: "agent", sourceThread: { backend: "codex", threadId: "invented-sender", instanceId: "invented-peer" } };
        const waiting = { id: "queue-second", threadId: ref.threadId, prompt: "Invented waiting input", messageOrigin };
        expect(runtime.submit(waiting).status).toBe("queued");
        expect((await backend.handle("getNavigationQueueProjection", { protocol: 2, ref })).entries).toMatchObject([{ queueEntryId: waiting.id }]);
        runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: "queue-turn-1", status: "completed" } } });
        for (let n = 0; n < 12; n++) await new Promise<void>(resolve => setImmediate(resolve));
        expect((await backend.handle("getNavigationQueueProjection", { protocol: 2, ref })).entries).toMatchObject([{ queueEntryId: waiting.id, manualReleaseRequired: true }]);
        backend.persistCreatedNativeThread({ id: "queue-other", cwd: workspace, title: "Other invented thread", titleSource: "explicit" });
        let contended = false;
        let pauseDuringRelease: Promise<unknown> | undefined, moveDuringRelease: Promise<unknown> | undefined;
        let replacementDuringRelease: Promise<string> | undefined;
        runtime.onEvent = (event: any) => {
          backend.event(event);
          if (!contended && event.method === "headless/queueChanged" && event.params.type === "queued" && event.params.entry.id === waiting.id) {
            contended = true;
            expect(runtime.submit({ id: "queue-competitor", threadId: "queue-other", prompt: "Invented competing input" }).status).toBe("queued");
            pauseDuringRelease = backend.handle("backend.setQueuedTurnPaused", { queueEntryId: waiting.id, paused: true });
            moveDuringRelease = backend.handle("backend.moveQueuedTurn", { queueEntryId: waiting.id });
            replacementDuringRelease = backend.handle("backend.replaceQueuedMessage", { ...ref, queueEntryId: waiting.id,
              input: [{ type: "text", text: "Invented too-late replacement" }], messageOrigin },
            { id: "invented-replacement", sourceInstanceId: "invented-peer" }).then(() => "unexpected acceptance", (error: Error) => error.message);
          }
        };
        expect(await backend.handle("backend.releaseQueuedTurn", { queueEntryId: waiting.id })).toMatchObject({ disposition: "started", turnId: "queue-turn-3" });
        expect(contended).toBe(true);
        expect(await pauseDuringRelease).toMatchObject({ disposition: "not_found" });
        expect(await moveDuringRelease).toMatchObject({ disposition: "not_found" });
        expect(await replacementDuringRelease).toContain("not found or already started");
        expect(store.jobs.size).toBe(3);
        expect(store.get("queue-competitor")).toMatchObject({ status: "queued" });
        expect(store.get(waiting.id)).toMatchObject({ status: "running", turnId: "queue-turn-3" });
        runtime.submit({ id: "queue-delete", threadId: ref.threadId, prompt: "Invented deleted input" });
        expect(await backend.handle("backend.cancelQueuedTurn", { queueEntryId: "queue-delete" })).toMatchObject({ disposition: "cancelled", cancelled: true });
        expect(await backend.handle("backend.cancelQueuedTurn", { queueEntryId: waiting.id })).toMatchObject({ disposition: "already_admitted", cancelled: false });
        const pending = runtime.submit({ id: "queue-unfinished", threadId: ref.threadId, prompt: "Invented never-replayed input" });
        fingerprint = pending.fingerprint;
        runtime.submit({ id: "queue-ordered", threadId: ref.threadId, prompt: "Invented ordered input" });
        expect(await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: pending.id, paused: true })).toMatchObject({ disposition: "updated", pauseRevision: 1 });
        expect(await backend.handle("backend.moveQueuedTurn", { queueEntryId: "queue-ordered", beforeQueueEntryId: pending.id })).toMatchObject({ disposition: "moved", queueEntryIds: ["queue-ordered", pending.id] });
        runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: "queue-turn-3", status: "completed" } } });
        for (let n = 0; n < 12; n++) await new Promise<void>(resolve => setImmediate(resolve));
        expect(store.get("queue-ordered")).toMatchObject({ status: "running", turnId: "queue-turn-4" });
        expect(await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: pending.id, paused: false })).toMatchObject({ disposition: "updated", pauseRevision: 2 });
        expect(await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: pending.id, paused: true })).toMatchObject({ disposition: "updated", pauseRevision: 3 });
        await runtime.stop();
        expect(store.get("queue-unfinished")).toMatchObject({ status: "unknown", fingerprint });
        expect(store.get("queue-unfinished")).not.toHaveProperty("turnId");
        expect(sends).toBe(4);
      } finally { profile.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const queue = await app.window.evaluate(async identity => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return await api.getNavigationQueueProjection!({ protocol: 2, ref: identity });
    }, ref);
    expect(queue.entries).toEqual([]);
    await app.closeApplication();
    const workspace = realpathSync(app.homeRoot);
    const profile = openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(app.homeRoot)), profileName: "default", cwd: workspace });
    try {
      const store = new JobStore(headless, { version: 1, workspace, codexHome: path.join(app.homeRoot, "codex") }, profile);
      expect(store.get("queue-first")).toMatchObject({ status: "completed", turnId: "queue-turn-1" });
      expect(store.get("queue-second")).toMatchObject({ status: "completed", turnId: "queue-turn-3" });
      expect(store.get("queue-ordered")).toMatchObject({ status: "unknown", turnId: "queue-turn-4" });
      expect(store.get("queue-unfinished")).toMatchObject({ status: "unknown", fingerprint });
      expect(store.get("queue-delete")).toMatchObject({ status: "interrupted" });
      expect(store.get("queue-delete")).not.toHaveProperty("turnId");
      expect(store.get("queue-competitor")).toMatchObject({ status: "unknown", threadId: "queue-other" });
      expect(store.get("queue-competitor")).not.toHaveProperty("turnId");
    } finally { profile.close(); }
  } finally { await app.close(); }
});

test("Outpost creation, stable retries and refused queue dispatch preserve owner state through desktop handover", async () => {
  test.skip(process.platform === "win32", "The executable Outpost Runtime supports Linux and macOS");
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation-backend.js")]);
  const ref = { backend: "codex" as const, threadId: "thread-smoke" };
  let headless = "";
  let acceptedId = "";
  let refusedId = "";
  const app = await launchElectronApp({
    secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const workspace = realpathSync(homeRoot);
      const stateDirectory = path.dirname(stateDbPathForHomeRoot(homeRoot));
      headless = path.join(stateDirectory, "headless");
      const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: workspace });
      let finishCreation!: () => void;
      let finishTurn!: () => void;
      const creating = new Promise<void>(resolve => { finishCreation = resolve; });
      const starting = new Promise<void>(resolve => { finishTurn = resolve; });
      const tick = () => new Promise<void>(resolve => setImmediate(resolve));
      const store = new JobStore(headless, { version: 1, workspace, codexHome: path.join(homeRoot, "codex") }, profile);
      const runtime = new Runtime({ workspace, store, home: path.join(homeRoot, "codex"), command: "unused", onFailure() {} });
      try {
        let sends = 0;
        runtime.codex = {
          startThread: async () => { await creating; return { threadId: "created" }; },
          startTurn: async () => {
            const sequence = ++sends;
            if (sequence === 2) await starting;
            if (sequence === 3) throw new Error("Invented provider refusal");
            return { threadId: ref.threadId, turnId: `review-turn-${sequence}` };
          },
          stop: async () => {},
        };
        const backend = new HeadlessBackend(runtime, () => {});
        runtime.onEvent = (event: unknown) => backend.event(event);
        backend.persistCreatedNativeThread({ id: ref.threadId, cwd: workspace, title: "Replay smoke thread", titleSource: "explicit", createdAt: Date.now() });
        const creation = backend.startThread({});
        expect(runtime.submit({ id: "creation-waiter", threadId: ref.threadId, prompt: "Invented creation waiter" }).status).toBe("queued");
        finishCreation(); await creation;
        for (let n = 0; n < 12; n++) await tick();
        expect(store.get("creation-waiter")).toMatchObject({ status: "running", turnId: "review-turn-1" });
        runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: "review-turn-1", status: "completed" } } });
        for (let n = 0; n < 12; n++) await tick();
        const request = { threadId: ref.threadId, input: [{ type: "text", text: "Invented stable input" }], queueEntryId: "stable" };
        const envelope = { id: "first", sourceInstanceId: "invented-peer" };
        const first = backend.startTurn(request, envelope);
        for (let n = 0; n < 12; n++) await tick();
        expect(sends).toBe(2);
        const queued = await backend.startTurn({ ...request, queueEntryId: "held", input: [{ type: "text", text: "Invented held input" }] }, { ...envelope, id: "held" });
        refusedId = queued.queueEntryId;
        let settled = false;
        const retry = backend.startTurn(request, envelope).finally(() => { settled = true; });
        for (let n = 0; n < 12; n++) await tick();
        expect(settled).toBe(false);
        finishTurn();
        const result = await first;
        expect(await retry).toEqual(result);
        acceptedId = result.queueEntryId;
        runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: "review-turn-2", status: "completed" } } });
        for (let n = 0; n < 12; n++) await tick();
        expect(store.get(refusedId)).toMatchObject({ status: "queued", reason: "Invented provider refusal" });
        expect(runtime.active).toBeNull();
        expect(await backend.handle("resolveThreadAdmissionState", { threadId: ref.threadId })).toMatchObject({ threadStatus: "idle" });
        expect(backend.summary(backend.owned(ref.threadId)).threadStatus).toBe("idle");
        expect(backend.queuedTurns(ref.threadId)).toMatchObject([{ queueEntryId: refusedId, manualReleaseRequired: true }]);
        await runtime.stop();
        expect(store.get(refusedId)).toMatchObject({ status: "unknown" });
        expect(sends).toBe(3);
      } finally { finishCreation(); finishTurn(); await runtime.stop(); profile.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const queue = await app.window.evaluate(async identity => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return await api.getNavigationQueueProjection!({ protocol: 2, ref: identity });
    }, ref);
    expect(queue.entries).toEqual([]);
    await app.closeApplication();
    const workspace = realpathSync(app.homeRoot);
    const profile = openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(app.homeRoot)), profileName: "default", cwd: workspace });
    try {
      const store = new JobStore(headless, { version: 1, workspace, codexHome: path.join(app.homeRoot, "codex") }, profile);
      expect(store.get(acceptedId)).toMatchObject({ status: "completed", turnId: "review-turn-2" });
      expect(store.get(refusedId)).toMatchObject({ status: "unknown" });
      expect(store.get(refusedId)).not.toHaveProperty("turnId");
    } finally { profile.close(); }
  } finally { await app.close(); }
});

test("an Outpost shared helper title reaches the actual desktop renderer and survives owner handover without replay", async () => {
  test.skip(process.platform === "win32", "The executable Outpost Runtime supports Linux and macOS");
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation-backend.js")]);
  const ref = { backend: "codex" as const, threadId: "thread-smoke" };
  const title = "Replay smoke thread";
  let headless = "";
  const app = await launchElectronApp({
    secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const stateDirectory = path.dirname(stateDbPathForHomeRoot(homeRoot));
      const workspace = realpathSync(homeRoot);
      headless = path.join(stateDirectory, "headless");
      const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: workspace });
      try {
        const store = new JobStore(headless, { version: 1, workspace, codexHome: path.join(homeRoot, "codex") }, profile);
        let helpers = 0;
        const runtime = new Runtime({ workspace, store, home: path.join(homeRoot, "codex"), command: "unused", onFailure() {} });
        runtime.codex = {
          startThread: async () => ({ threadId: ref.threadId }),
          startTurn: async () => {
            runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: "turn-owned", status: "completed" } } });
            return { threadId: ref.threadId, turnId: "turn-owned" };
          },
          generateTitle: async () => { helpers++; return { status: "ok", object: { title } }; },
          renameThread: async () => ({ threadId: ref.threadId }),
        };
        const backend = new HeadlessBackend(runtime, () => {});
        runtime.onEvent = (event: { method: string }) => {
          backend.event(event);
          if (event.method === "headless/turnStarted") throw new Error("Invented viewer finalization refusal");
        };
        expect(await backend.handle("startThread")).toMatchObject(ref);
        const input = { id: "accepted", prompt: "Please inspect the replay harness", threadId: ref.threadId };
        const accepted = runtime.submit(input);
        await runtime.work;
        expect(store.get("accepted")).toMatchObject({ fingerprint: accepted.fingerprint, turnId: "turn-owned", status: "completed" });
        expect(runtime.submit(input)).toEqual(store.get("accepted"));
        await backend.titles.whenSettled();
        expect(helpers).toBe(1);
        expect(backend.summary(backend.owned(ref.threadId))).toMatchObject({ title, titleSource: "derived" });
      } finally { profile.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const thread = await app.window.evaluate(async identity => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.getNavigationSelectedDetail!({ protocol: 2, ref: identity })).thread;
    }, ref);
    expect(thread).toMatchObject({ title, titleSource: "derived" });
    await app.closeApplication();
    const workspace = realpathSync(app.homeRoot);
    const profile = openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(app.homeRoot)), profileName: "default", cwd: workspace });
    try {
      const store = new JobStore(headless, { version: 1, workspace, codexHome: path.join(app.homeRoot, "codex") }, profile);
      expect(store.threadRegistry.getThreadMetadata(ref).title).toMatchObject({ text: title, source: "derived", nativeName: title });
      expect(store.get("accepted")).toMatchObject({ threadId: ref.threadId, turnId: "turn-owned", status: "completed" });
    } finally { profile.close(); }
  } finally { await app.close(); }
});

test("accepted Outpost steering and interruption survive desktop owner handover without replay", async () => {
  test.skip(process.platform === "win32", "The executable Outpost Runtime supports Linux and macOS");
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation-backend.js")]);
  const ref = { backend: "codex" as const, threadId: "thread-smoke" };
  let headless = "";
  const app = await launchElectronApp({
    secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const workspace = realpathSync(homeRoot);
      const stateDirectory = path.dirname(stateDbPathForHomeRoot(homeRoot));
      headless = path.join(stateDirectory, "headless");
      const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: workspace });
      try {
        const store = new JobStore(headless, { version: 1, workspace, codexHome: path.join(homeRoot, "codex") }, profile);
        const runtime = new Runtime({ workspace, store, home: path.join(homeRoot, "codex"), command: "unused", onFailure() {} });
        let sends = 0;
        let interruptions = 0;
        const messagingCall = { operation: "send_private_response", context: { backend: "codex", threadId: ref.threadId, turnId: "turn-control" }, args: { text: "Private fixture reply" } };
        const forwarded: any[] = [];
        runtime.requestMessaging = async (call: unknown) => { forwarded.push(call); return { ok: true }; };
        runtime.codex = {
          startThread: async () => ({ threadId: ref.threadId }),
          startTurn: async () => ({ threadId: ref.threadId, turnId: "turn-control" }),
          steerTurn: async () => {
            sends++;
            // Provider tool dispatch precedes the native steering response.
            expect(await runtime.messagingRequest(messagingCall)).toMatchObject({ ok: false, error: { code: "forbidden" } });
            expect(forwarded).toHaveLength(1);
            return { threadId: ref.threadId, turnId: "turn-control" };
          },
          interruptTurn: async () => {
            interruptions++;
            runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: "turn-control", status: "interrupted" } } });
            return {};
          },
        };
        const backend = new HeadlessBackend(runtime, () => {});
        runtime.onEvent = (event: unknown) => backend.event(event);
        backend.authenticateOrigin = (origin: unknown) => origin;
        const input = { id: "controlled", prompt: "Replay smoke thread", messageOrigin: { kind: "messaging", causalMessagingSource: { ownerId: "fixture", requestId: "sender-a" } } };
        runtime.submit(input);
        await runtime.work;
        await runtime.messagingRequest(messagingCall);
        expect(forwarded[0].context.causalMessagingSource).toEqual(input.messageOrigin.causalMessagingSource);
        const save = store.save.bind(store);
        let refuse = true;
        store.save = (job: any) => { if (job.messageOrigin && refuse) { refuse = false; throw new Error("origin refused"); } return save(job); };
        const request = { ...ref, expectedTurnId: "turn-control", requestId: "one-steer", input: [{ type: "text", text: "Inspect this boundary" }], messageOrigin: { kind: "agent", systemReason: "fixture-steer", causalMessagingSource: { ownerId: "fixture", requestId: "sender-b" } } };
        await expect(backend.handle("steerTurn", request)).rejects.toThrow("origin refused");
        expect(await runtime.messagingRequest(messagingCall)).toMatchObject({ ok: false, error: { code: "forbidden" } });
        expect(forwarded).toHaveLength(1);
        const copies = await Promise.all(Array.from({ length: 3 }, () => backend.handle("controlActiveTurn", { ...request, operation: "steer" })));
        for (const result of copies) expect(result).toMatchObject({ ok: true, turnId: "turn-control", disposition: "steered" });
        await runtime.messagingRequest(messagingCall);
        expect(forwarded).toHaveLength(2);
        expect(forwarded[1].context.causalMessagingSource).toBeUndefined();
        expect(forwarded[1].context.causalMessagingAmbiguous).toBe(true);
        await expect(backend.handle("steerTurn", { ...request, input: [{ type: "text", text: "changed" }] })).rejects.toThrow("reused with different input");
        expect(await backend.handle("controlActiveTurn", { ...ref, expectedTurnId: "turn-control", requestId: "stop", operation: "stop" })).toMatchObject({ ok: true, disposition: "interrupted" });
        expect(runtime.submit(input)).toMatchObject({ status: "interrupted", turnId: "turn-control" });
        expect(sends).toBe(1);
        expect(interruptions).toBe(1);
      } finally { profile.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const thread = await app.window.evaluate(async identity => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.getNavigationSelectedDetail!({ protocol: 2, ref: identity })).thread;
    }, ref);
    expect(thread).toMatchObject({ id: ref.threadId, title: "Replay smoke thread" });
    await app.closeApplication();
    const workspace = realpathSync(app.homeRoot);
    const profile = openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(app.homeRoot)), profileName: "default", cwd: workspace });
    try {
      const store = new JobStore(headless, { version: 1, workspace, codexHome: path.join(app.homeRoot, "codex") }, profile);
      expect(store.get("controlled")).toMatchObject({ threadId: ref.threadId, turnId: "turn-control", status: "interrupted", messageOrigin: { kind: "agent", systemReason: "fixture-steer", causalMessagingAmbiguous: true } });
    } finally { profile.close(); }
  } finally { await app.close(); }
});

test("desktop baseline reads, metadata-only titles and archive observations survive actual Outpost takeover", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const identity = { backend: "codex" as const, threadId: "thread-smoke" };
  const app = await launchElectronApp({
    secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const stateDirectory = path.dirname(stateDbPathForHomeRoot(homeRoot));
      const headless = path.join(stateDirectory, "headless");
      await mkdir(headless, { recursive: true, mode: 0o700 });
      const ownerIdentity = { version: 1, workspace: homeRoot, codexHome: path.join(homeRoot, "codex") };
      await writeFile(path.join(headless, "identity.json"), JSON.stringify(ownerIdentity));
      await writeFile(path.join(headless, "threads.json"), JSON.stringify({ version: 1, threads: [{ id: "metadata-only" }] }));
      const imported = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: homeRoot });
      try { new JobStore(headless, ownerIdentity, imported); } finally { imported.close(); }
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const overlay = new SqliteOverlayStore(db);
        const retained: AppServerThreadSummary = { id: identity.threadId, source: "codex", title: "Replay smoke thread",
          titleSource: "explicit", updatedAt: 1760000000000, linkedDirectories: [] };
        seedRetainedOutpostUnreadThread(db, retained);
        await overlay.setThreadExecutionMode({ backend: "codex", threadId: "metadata-only", executionMode: "auto" });
        await overlay.observeArchivedThreads([{ backend: "codex", threadId: "observed-archive" }], 1);
      } finally { db.close(); }
    },
  });
  try {
    await expect(app.window.getByRole("button", { name: /Replay smoke thread/i }).first()).toBeVisible();
    const desktop = await app.window.evaluate(async ref => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.getNavigationSelectedDetail!({ protocol: 2, ref })).thread;
    }, identity);
    expect(desktop?.inbox.inInbox).toBe(false);
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try { expect((await new SqliteOverlayStore(db).getThreadMetadata(identity))?.seenUpdatedAt).toBeUndefined(); }
    finally { db.close(); }
    const stateDirectory = path.dirname(stateDbPathForHomeRoot(app.homeRoot));
    const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: app.homeRoot });
    try {
      const store = new JobStore(path.join(stateDirectory, "headless"),
        { version: 1, workspace: app.homeRoot, codexHome: path.join(app.homeRoot, "codex") }, profile);
      const backend = new HeadlessBackend({ workspace: app.homeRoot, store, projects: { list: () => [] },
        onFailure(error: unknown) { throw error; } }, () => {});
      expect(backend.summary(backend.owned(identity.threadId)).inbox.inInbox).toBe(desktop!.inbox.inInbox);
      expect(() => backend.owned("observed-archive")).toThrow("Thread is not owned");
      expect(backend.runtime.ownsThread("observed-archive")).toBe(false);
      const filtered = await backend.handle("getNavigationQueryPage", {
        protocol: 2, query: { kind: "lens", lens: "recents", filter: "untitled" },
      });
      expect(filtered.entries.map((entry: { row: { id: string; title: string; titleSource: string } }) => entry.row))
        .toEqual([expect.objectContaining({ id: "metadata-only", title: "Untitled thread", titleSource: "fallback" })]);
      await backend.handle("markThreadSeen", { threadId: identity.threadId, seenAt: Date.now() + 60000 });
      expect(backend.summary(backend.owned(identity.threadId)).inbox.inInbox).toBe(false);
    } finally { profile.close(); }
  } finally { await app.close(); }
});

test("the actual Outpost registry adopts legacy owner data and receives desktop metadata edits after shutdown", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const identity = { backend: "codex" as const, threadId: "thread-smoke" };
  let headless = "";
  let legacyBytes = "";
  const app = await launchElectronApp({
    secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const stateDirectory = path.dirname(stateDbPathForHomeRoot(homeRoot));
      headless = path.join(stateDirectory, "headless");
      await mkdir(path.join(headless, "jobs"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(headless, "identity.json"), JSON.stringify({ version: 1, workspace: homeRoot, codexHome: path.join(homeRoot, "codex") }));
      legacyBytes = JSON.stringify({ version: 1, threads: [{ id: identity.threadId, title: "Legacy Outpost owner title", titleSource: "explicit",
        createdAt: 1, sandbox: "read-only", pinnedRank: "1024", seenAt: 2, seenUpdatedAt: 1,
        parentThreadId: "legacy-parent", parentThreadBackend: "claude", messagingFileTools: true }] });
      await writeFile(path.join(headless, "threads.json"), legacyBytes);
      await writeFile(path.join(headless, "jobs/legacy.json"), JSON.stringify({ version: 1, id: "legacy", fingerprint: "retained", status: "running",
        threadId: identity.threadId, createdAt: "2026-01-01T00:00:00Z" }));
      const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: homeRoot });
      try {
        const store = new JobStore(headless, { version: 1, workspace: homeRoot, codexHome: path.join(homeRoot, "codex") }, profile);
        const backend = new HeadlessBackend({ workspace: homeRoot, store, onFailure(error: unknown) { throw error; } }, () => {});
        expect(store.get("legacy")).toMatchObject({ status: "unknown", fingerprint: "retained" });
        expect(await backend.threadRegistry.getThreadMetadata(identity)).toMatchObject({ title: { text: "Legacy Outpost owner title", source: "explicit" }, pinnedRank: "1024" });
      } finally { profile.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Legacy Outpost owner title/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const result = await app.window.evaluate(async ref => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const before = (await api.getNavigationSelectedDetail!({ protocol: 2, ref })).thread;
      await api.setThreadPin!({ ...ref, pinnedRank: "8192" });
      await api.setThreadParent!({ ...ref, parentThreadId: null });
      const seenAt = Date.now() + 60_000;
      await api.markThreadSeen!({ ...ref, seenAt, seenUpdatedAt: before!.updatedAt });
      return { before, seenAt };
    }, identity);
    expect(result.before).toMatchObject({ title: "Legacy Outpost owner title", titleSource: "explicit", pinnedRank: "1024", parentThreadId: "legacy-parent" });
    await app.closeApplication();
    const profile = openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(app.homeRoot)), profileName: "default", cwd: app.homeRoot });
    try {
      const store = new JobStore(headless, { version: 1, workspace: app.homeRoot, codexHome: path.join(app.homeRoot, "codex") }, profile);
      const backend = new HeadlessBackend({ workspace: app.homeRoot, store, onFailure(error: unknown) { throw error; } }, () => {});
      const metadata = await backend.threadRegistry.getThreadMetadata(identity);
      expect(metadata).toMatchObject({ title: { text: "Legacy Outpost owner title", source: "explicit" }, pinnedRank: "8192", seenAt: result.seenAt });
      expect(metadata.parent).toBeUndefined();
      const summary = backend.summary(backend.owned(identity.threadId));
      expect(summary.pinnedRank).toBe("8192");
      // Recovery is newer than the replay provider row. Acknowledging that
      // older row must not read the recovered job merely because seenAt is later.
      expect(summary.inbox.inInbox).toBe(summary.updatedAt > (metadata.seenUpdatedAt ?? metadata.seenAt ?? 0));
      expect(store.get("legacy")).toMatchObject({ status: "unknown", fingerprint: "retained" });
      expect(await readFile(path.join(headless, "legacy-owner-backup-v1/threads.json"), "utf8")).toBe(legacyBytes);
    } finally { profile.close(); }
  } finally { await app.close(); }
});
