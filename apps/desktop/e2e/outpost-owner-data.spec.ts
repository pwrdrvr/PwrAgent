import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { startOutpostDaemon } from "../src/main/__tests__/helpers/outpost-daemon";

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
