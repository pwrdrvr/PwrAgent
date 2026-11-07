import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_MINIMUM_RECOMMENDED_VERSION, parseCodexVersionCore } from "@pwragent/shared";
import { CODEX_COMMAND_ENV as DISCOVERY_COMMAND_ENV } from "@pwrdrvr/codex-discovery";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { FAKE_CODEX_VERSION, writeFakeCodexExecutable } from "./fixtures/fake-agent-executables";

const specDir = path.dirname(fileURLToPath(import.meta.url));

for (const explicit of [false, true]) {
  test(`replay discovery ${explicit ? "honors an explicit old CLI" : "ignores an ambient old CLI"}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "replay-discovery-e2e-"));
    let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    try {
      const command = await writeFakeCodexExecutable({
        targetPath: path.join(root, "codex"),
        protocolLogPath: path.join(root, "protocol.jsonl"),
        launchMarkerPath: path.join(root, "launched.json"),
      });
      const inherited = process.env.PWRAGENT_CODEX_COMMAND;
      const inheritedDiscovery = process.env[DISCOVERY_COMMAND_ENV];
      try {
        // This is the worker's ambient environment, not a per-launch override.
        // Only the explicit scenario grants that CLI ownership of discovery.
        process.env.PWRAGENT_CODEX_COMMAND = command;
        process.env[DISCOVERY_COMMAND_ENV] = command;
        app = await launchElectronApp({
          fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
          windowSize: { width: 976, height: 640 },
          ...(explicit ? { env: { PWRAGENT_CODEX_COMMAND: command } } : {}),
        });
      } finally {
        if (inherited === undefined) delete process.env.PWRAGENT_CODEX_COMMAND;
        else process.env.PWRAGENT_CODEX_COMMAND = inherited;
        if (inheritedDiscovery === undefined) delete process.env[DISCOVERY_COMMAND_ENV];
        else process.env[DISCOVERY_COMMAND_ENV] = inheritedDiscovery;
      }
      const launched = app;
      await launched.window.getByRole("button", { name: "Open settings", exact: true }).click();
      await expect.poll(async () => {
        const codex = await launched.window.evaluate(async () => {
          const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
          return (await api.readSettings!({})).snapshot.models.codex;
        });
        const selected = codex.discovery.candidates.find((candidate) => candidate.selected);
        const relative = selected && path.relative(launched.homeRoot, selected.command);
        return {
          selectedIsOwned: relative !== undefined
            && !path.isAbsolute(relative)
            && !/^\.\.(?:[/\\]|$)/.test(relative),
          selectedIsExplicit: selected?.command === command,
          version: parseCodexVersionCore(selected?.version)?.join("."),
          advisory: codex.versionAdvisory?.version ?? null,
        };
      }).toEqual({
        selectedIsOwned: !explicit,
        selectedIsExplicit: explicit,
        version: explicit ? FAKE_CODEX_VERSION : CODEX_MINIMUM_RECOMMENDED_VERSION,
        advisory: explicit ? FAKE_CODEX_VERSION : null,
      });
      const advisory = launched.window.locator(`[data-notice-id="codex-version:${FAKE_CODEX_VERSION}"]`);
      if (explicit) await expect(advisory).toBeVisible();
      else await expect(advisory).toHaveCount(0);
    } finally {
      if (app) {
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  });
}
