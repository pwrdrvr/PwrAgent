import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ensureNamedProfileExists } from "../profile";
import { runNativeFixtureCommand } from "../../test-setup/native-helper-fixture";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";

// The emitted owner and real shell are the oracle: constructing an unused
// provider must not start a probe, while first use must still hydrate its env.
it("desktop and Outpost defer login-shell probing until the environment is requested", async ({ signal }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owner-shell-env-")));
  const observations: Array<{ kind: string; value: Record<string, unknown> }> = [];
  try {
    const shell = path.join(root, "fixture-shell");
    fs.writeFileSync(shell, "#!/bin/sh\nprintf '%s\\n' '__PWRAGENT_LOGIN_SHELL_ENV_START__' 'PATH=/usr/bin:/bin' 'OWNER_SHELL_MARKER=hydrated' '__PWRAGENT_LOGIN_SHELL_ENV_END__'\n", { mode: 0o755 });
    for (const kind of ["desktop", "headless"] as const) {
      const directory = path.join(root, kind);
      const guard = await buildOwnerFixture(directory, kind);
      const home = path.join(directory, "home");
      ensureNamedProfileExists("fixture", { env: { ...process.env, PWRAGENT_HOME: home } });
      const result = path.join(directory, "result.json");
      const driver = path.join(directory, "driver.cjs");
      fs.writeFileSync(driver, `
        Object.assign(process.env, {
          PWRAGENT_HOME: ${JSON.stringify(home)}, PWRAGENT_PROFILE: "fixture",
          CLAUDE_CONFIG_DIR: ${JSON.stringify(path.join(directory, "claude"))},
          SHELL: ${JSON.stringify(shell)},
        });
        delete process.env.OWNER_SHELL_MARKER;
        // Record actual launches synchronously before forwarding to execFile.
        // No sleep is needed to prove that startup admitted no shell process.
        const cp = require("node:child_process"), execute = cp.execFile;
        let probes = 0;
        cp.execFile = function(command, ...args) {
          if (command === process.env.SHELL) probes++;
          return execute.call(this, command, ...args);
        };
        for (const key of Object.getOwnPropertySymbols(execute)) {
          Object.defineProperty(cp.execFile, key, Object.getOwnPropertyDescriptor(execute, key));
        }
        const app = require("./dist/index.js");
        (async () => {
          const services = await app.startHeadlessHost(undefined, { manageSignals: false });
          let observation;
          try {
            const startup = probes;
            const [a, b] = await Promise.all([
              services.settings.resolveCodexSpawnEnvAsync(),
              services.settings.resolveCodexSpawnEnvAsync(),
            ]);
            observation = { startup, firstUse: probes, a: a.OWNER_SHELL_MARKER,
              b: b.OWNER_SHELL_MARKER, cached: services.settings.resolveCodexSpawnEnv().OWNER_SHELL_MARKER };
          } finally { await app.shutdownHeadlessHost("shell-env-oracle"); }
          require("node:fs").writeFileSync(${JSON.stringify(result)}, JSON.stringify(observation));
        })().catch(error => { require("node:fs").writeSync(2, error.stack + String.fromCharCode(10)); process.exitCode = 1; });
      `);
      // The helper joins the actual process group / Windows Job and stdio
      // before this test removes its bundle, profile or executable fixture.
      await runNativeFixtureCommand(process.execPath, ["--require", guard, driver]);
      signal.throwIfAborted();
      observations.push({ kind, value: JSON.parse(fs.readFileSync(result, "utf8")) });
    }
    for (const { kind, value: observation } of observations) {
      expect(observation.startup, kind).toBe(0);
      if (process.platform === "win32") {
        expect(observation).toEqual({ startup: 0, firstUse: 0 });
      } else {
        expect(observation).toEqual({ startup: 0, firstUse: 1,
          a: "hydrated", b: "hydrated", cached: "hydrated" });
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
