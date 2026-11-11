import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { OUTPOST_VIEWER_CAPABILITIES, startOutpostDaemon } from "../src/main/__tests__/helpers/outpost-daemon";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test.beforeAll(() => {
  execFileSync(process.execPath, [path.resolve(specDir, "../../../packages/pwragent/scripts/build.mjs")], {
    cwd: path.resolve(specDir, "../../.."), stdio: "pipe",
  });
});

test("the mounted Node owner keeps one native turn and distinct immutable queued inputs", async () => {
  test.skip(process.platform === "win32", "The executable Outpost supports Linux and macOS");
  test.setTimeout(120_000);
  const outpost = await startOutpostDaemon({ packageRoot: path.resolve(specDir, "../../../packages/pwragent") });
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  const command = async (method: string, params: Record<string, unknown> = {}) => {
    const file = path.join(outpost.env.PWRAGENT_TEST_DATA!, `command-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(params));
    return JSON.parse((await promisify(execFile)(process.execPath, [outpost.cli, method, "--params-file", file], { env: outpost.env })).stdout);
  };
  try {
    const identity = await outpost.client.startThread({ backend: "codex", cwd: outpost.workspace });
    await outpost.client.renameThread({ ...identity, name: "Invented Node owner" });
    const active = await outpost.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const request = { ...identity, delivery: "new_turn" as const, queueEntryId: randomUUID(), input: [{ type: "text" as const, text: "Invented queued input" }] };
    const queued = await outpost.client.startTurn(request);
    expect(queued).toMatchObject({ queueStatus: "queued", queueEntryId: request.queueEntryId });
    expect(await outpost.client.startTurn(request)).toMatchObject({ queueEntryId: queued.queueEntryId });
    const invite = await command("federation-invite");
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
        id: threadId, source: "codex", title: "Invented Node owner", titleSource: "explicit", linkedDirectories: [],
        threadStatus: "active", inbox: { inInbox: true }, updatedAt: 2_000,
        federation: { ref, instanceLabel: "Invented Outpost", peerStatus: "connected" },
      } });
    }, { instanceId: outpost.ownerInstanceId, threadId: identity.threadId });
    await app.window.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: "Invented Node owner", exact: true }).click();
    const thinking = app.window.getByRole("img", { name: "Thinking on another instance", exact: true });
    await expect(thinking).toHaveCount(1);
    const row = app.window.locator(".composer__queued").filter({ hasText: "Invented queued input" });
    await expect(row).toHaveCount(1);
    await command("pause", { queueEntryId: queued.queueEntryId });
    expect((await outpost.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries[0]).toMatchObject({ queueEntryId: queued.queueEntryId, paused: true });
    await command("resume", { queueEntryId: queued.queueEntryId });
    const replacement = await outpost.client.replaceQueuedMessage({ ...identity, queueEntryId: queued.queueEntryId!, input: [{ type: "text", text: "Invented replacement input" }] });
    expect(replacement.queueEntryId).not.toBe(queued.queueEntryId);
    await expect(row).toHaveCount(0);
    const changed = app.window.locator(".composer__queued").filter({ hasText: "Invented replacement input" });
    await expect(changed).toHaveCount(1);
    expect((await command("show", identity)).threadId).toBe(identity.threadId);
    await command("cancel", { queueEntryId: replacement.queueEntryId });
    await expect(changed).toHaveCount(0);
    expect((await outpost.client.resolveThreadAdmissionState(identity)).activeTurn?.turnId).toBe(active.turnId);
    await outpost.client.interruptTurn(active);
    await expect(thinking).toHaveCount(0);
  } finally { await app?.close(); await outpost.close(); }
});

async function mountOutpost(title: string) {
  const outpost = await startOutpostDaemon({ packageRoot: path.resolve(specDir, "../../../packages/pwragent"), capabilities: [...OUTPOST_VIEWER_CAPABILITIES, "turn_queue_pause"] });
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    const identity = await outpost.client.startThread({ backend: "codex", cwd: outpost.workspace });
    await outpost.client.renameThread({ ...identity, name: title });
    const file = path.join(outpost.env.PWRAGENT_TEST_DATA!, `invite-${randomUUID()}.json`);
    await writeFile(file, "{}");
    const invite = JSON.parse((await promisify(execFile)(process.execPath, [outpost.cli, "federation-invite", "--params-file", file], { env: outpost.env })).stdout);
    app = await launchElectronApp({ secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json") });
    await app.window.evaluate(async encoded => {
      await (window as unknown as { pwragent: DesktopApi }).pwragent.importFederationInvite!({ invite: encoded });
    }, invite.invite);
    await expect.poll(async () => app!.window.evaluate(async () =>
      (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health.status)).toBe("connected");
    await app.window.evaluate(async ({ instanceId, threadId, title }) => {
      const ref = { backend: "codex" as const, threadId, target: { scope: "remote" as const, instanceId } };
      await (window as unknown as { pwragent: DesktopApi }).pwragent.addRemoteThreadPin!({ ref, instanceLabel: "Invented Outpost", summary: {
        id: threadId, source: "codex", title, titleSource: "explicit", linkedDirectories: [], threadStatus: "idle",
        inbox: { inInbox: false }, updatedAt: 2_000,
        federation: { ref, instanceLabel: "Invented Outpost", peerStatus: "connected" },
      } });
    }, { instanceId: outpost.ownerInstanceId, threadId: identity.threadId, title });
    await app.window.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: title, exact: true }).click();
    return { outpost, app, identity, queue: () => outpost.client.getNavigationQueueProjection({ protocol: 2, ref: identity }) };
  } catch (error) { await app?.close(); await outpost.close(); throw error; }
}

test("a remote queued message becomes a private viewer draft before edited input gets a new acceptance", async () => {
  test.skip(process.platform === "win32", "The executable Outpost supports Linux and macOS");
  test.setTimeout(120_000);
  const { outpost, app, identity, queue } = await mountOutpost("Invented private draft");
  try {
    const active = await outpost.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const prompt = `${"Invented queued Ω text beyond the preview. ".repeat(12)}Private edit tail.`;
    const accepted = await outpost.client.startTurn({ ...identity, delivery: "new_turn", queueEntryId: randomUUID(), input: [{ type: "text", text: prompt }] });
    const original = await outpost.client.readQueuedTurn({ ...identity, queueEntryId: accepted.queueEntryId! });
    const row = app.window.locator(".composer__queued").filter({ hasText: "Invented queued Ω text" });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    const reply = app.window.getByLabel("Reply", { exact: true });
    await expect(reply).toHaveText(prompt);
    await expect(row).toHaveCount(0);
    await expect.poll(async () => (await queue()).entries.length).toBe(0);
    await expect(outpost.client.readQueuedTurn({ ...identity, queueEntryId: accepted.queueEntryId! })).rejects.toThrow(/no longer waiting/);
    const edited = `${prompt} Locally changed.`;
    await reply.fill(edited);
    expect((await queue()).entries).toEqual([]);
    expect(await readFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8")).not.toContain("Locally changed.");
    expect((await outpost.client.resolveThreadAdmissionState(identity)).activeTurn?.turnId).toBe(active.turnId);
    await app.window.locator(".composer__send-submit-button").click();
    await expect.poll(async () => (await queue()).entries.length).toBe(1);
    const replacement = (await queue()).entries[0]!;
    expect(replacement.queueEntryId).not.toBe(accepted.queueEntryId);
    const input = await outpost.client.readQueuedTurn({ ...identity, queueEntryId: replacement.queueEntryId });
    expect(input.input).toEqual([{ type: "text", text: edited }]);
    expect(input.contentHash).not.toBe(original.contentHash);
    await outpost.client.interruptTurn(active);
    await expect.poll(async () => {
      const calls = (await readFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls.filter(call => call.method === "turn/start" && call.params.input[0].text === prompt)).toHaveLength(0);
      return calls.filter(call => call.method === "turn/start" && call.params.input[0].text === edited).length;
    }).toBe(1);
  } finally { await app.close(); await outpost.close(); }
});

test("viewer pause, order and held Retry controls act on the mounted owner's queue", async () => {
  test.skip(process.platform === "win32", "The executable Outpost supports Linux and macOS");
  test.setTimeout(120_000);
  const { outpost, app, identity, queue } = await mountOutpost("Invented remote queue controls");
  const displaced = `${outpost.workspace}-unavailable`;
  let missing = false;
  try {
    const active = await outpost.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const enqueue = (text: string) => outpost.client.startTurn({ ...identity, delivery: "new_turn", queueEntryId: randomUUID(), input: [{ type: "text", text }] });
    const first = await enqueue("Invented first waiting input"), second = await enqueue("Invented second waiting input");
    const row = (text: string) => app.window.locator(".composer__queued").filter({ hasText: text });
    await row("Invented first waiting input").getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(async () => (await queue()).entries.find(entry => entry.queueEntryId === first.queueEntryId)?.paused).toBe(true);
    await row("Invented first waiting input").getByRole("button", { name: "Resume", exact: true }).click();
    await expect.poll(async () => Boolean((await queue()).entries.find(entry => entry.queueEntryId === first.queueEntryId)?.paused)).toBe(false);
    await row("Invented second waiting input").getByRole("button", { name: /^Reorder:/ }).press("ArrowUp");
    await expect.poll(async () => (await queue()).entries.map(entry => entry.queueEntryId)).toEqual([second.queueEntryId, first.queueEntryId]);
    await outpost.client.cancelQueuedTurn({ queueEntryId: first.queueEntryId! });
    await outpost.client.cancelQueuedTurn({ queueEntryId: second.queueEntryId! });
    const guidance = (id: string, text: string) => ({ ...identity, queueEntryId: id, input: [{ type: "text" as const, text }],
      messageOrigin: { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "invented-sender" } } });
    await outpost.client.startTurn(guidance("viewer-ack", "hold-steer-ack"));
    await expect.poll(() => readFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "steer.ready"), "utf8").then(() => true, () => false)).toBe(true);
    const held = await outpost.client.startTurn(guidance("viewer-held", "Invented held viewer guidance"));
    await outpost.client.setQueuedTurnPaused({ queueEntryId: held.queueEntryId!, paused: true });
    await rename(outpost.workspace, displaced); missing = true;
    await writeFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "steer.release"), "release");
    const heldRow = row("Invented held viewer guidance");
    await heldRow.getByRole("button", { name: "Resume", exact: true }).click();
    await expect.poll(async () => (await queue()).entries[0]?.manualReleaseRequired).toBe(true);
    const before = await queue();
    const retry = heldRow.getByRole("button", { name: "Retry", exact: true });
    await retry.click();
    await expect(retry).toBeEnabled();
    await expect(heldRow).toContainText("Thread workspace is unavailable");
    expect(await queue()).toEqual(before);
    await rename(displaced, outpost.workspace); missing = false;
    await heldRow.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(heldRow).toHaveCount(0);
    expect((await outpost.client.resolveThreadAdmissionState(identity)).activeTurn?.turnId).toBe(active.turnId);
    const calls = (await readFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === "turn/steer" && call.params.input[0].text === "Invented held viewer guidance")).toHaveLength(1);
    await outpost.client.interruptTurn(active);
  } finally {
    if (missing) await rename(displaced, outpost.workspace);
    await app.close(); await outpost.close();
  }
});
