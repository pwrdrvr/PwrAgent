import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  linuxPasswordStorePath,
  probeSecretServices,
} from "../linux-password-store";

const require = createRequire(import.meta.url);
const fixture = join(import.meta.dirname, "fixtures", "linux-password-store-electron.cjs");
const source = join(import.meta.dirname, "..", "linux-password-store.ts");
// This test accesses a real keyring. Opt in only inside a disposable Linux
// session with its own D-Bus and secret service; ordinary Vitest must not use
// the operator's keyring. No setup or D-Bus probe runs on other platforms.
const enabled = process.platform === "linux"
  && process.env.PWRAGENT_TEST_LINUX_SECRET_STORE === "1";
const secretsAvailable = enabled && (() => {
  const probe = probeSecretServices();
  return probe.status === "ok"
    && (probe.owned.includes("org.freedesktop.secrets")
      || probe.activatable.includes("org.freedesktop.secrets"));
})();

let root: string;
let userDataDir: string;
let pwragentRoot: string;
let cipherPath: string;
let electronBinary: string;
let tsxLoader: string;

type ProbeResult = {
  selected: string | null;
  backend: string;
  available: boolean;
  roundtrip: string | null;
  restarted: string | null;
};

function launch(env: Record<string, string | undefined>): ProbeResult {
  const resultPath = join(root, `result-${process.hrtime.bigint()}.json`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.PWRAGENT_LINUX_PASSWORD_STORE;
  delete childEnv.PWRAGENT_E2E;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electronBinary, [fixture, `--user-data-dir=${userDataDir}`], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...childEnv,
      ...env,
      PWRAGENT_SECRET_STORE_USER_DATA: userDataDir,
      PWRAGENT_SECRET_STORE_RESULT: resultPath,
      PWRAGENT_HOME: pwragentRoot,
      PWRAGENT_SECRET_STORE_MODULE: source,
      PWRAGENT_SECRET_STORE_TSX: tsxLoader,
    },
  });
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(
      `electron exited ${child.status}: ${child.stderr || child.stdout}`,
    );
  }
  return JSON.parse(readFileSync(resultPath, "utf8")) as ProbeResult;
}

describe.skipIf(!secretsAvailable)("linux password store inside Electron", () => {
  beforeAll(() => {
    electronBinary = require("electron") as string;
    tsxLoader = require.resolve("tsx/cjs/api");
    root = mkdtempSync(join(tmpdir(), "pwragent-secret-store-electron-"));
    userDataDir = join(root, "user-data");
    pwragentRoot = join(root, "pwragent");
    mkdirSync(userDataDir);
    mkdirSync(pwragentRoot);
    cipherPath = join(root, "cipher.bin");
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it(
    "uses a remembered libsecret store for a later process",
    () => {
      writeFileSync(linuxPasswordStorePath(pwragentRoot), "gnome-libsecret\n");
      const first = launch({
        PWRAGENT_SECRET_STORE_CIPHER_OUT: cipherPath,
      });
      expect(first.selected).toBe("gnome-libsecret");
      expect(first.backend).toBe("gnome_libsecret");
      expect(first.available).toBe(true);
      expect(first.roundtrip).toBe("pwragent-secret-store");

      const second = launch({
        PWRAGENT_SECRET_STORE_CIPHER_IN: cipherPath,
      });
      expect(second.available).toBe(true);
      expect(second.restarted).toBe("pwragent-secret-store");
    },
    60_000,
  );
});
