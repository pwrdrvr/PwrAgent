import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplayClientsFromEnv } from "../testing/replay-runtime";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { listingDiagnostics } from "../diagnostics/listing-diagnostics";

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }));
vi.mock("electron", () => electron);

function readTimingBridge() {
  return globalThis.__PWRAGENT_E2E_MAIN_PROCESS_TIMING__;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete globalThis.__PWRAGENT_REPLAY_DRIVER__;
  delete globalThis.__PWRAGENT_E2E_MAIN_PROCESS_TIMING__;
});

describe("replay main-process timing bridge", () => {
  it("exposes the rings exactly when E2E=1, a replay fixture exists, and the app is unpackaged", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-timing-"));
    const fixture = path.join(root, "replay.fixture.json");
    fs.writeFileSync(fixture, JSON.stringify({ metadata: { backend: "codex", scenario: "timing" }, steps: [] }));
    try {
      fc.assert(fc.property(
        fc.constantFrom(undefined, "", "0", "true", "1", " 1 "), fc.boolean(), fc.boolean(),
        (e2e, hasFixture, isPackaged) => {
          delete globalThis.__PWRAGENT_E2E_MAIN_PROCESS_TIMING__;
          vi.stubEnv("PWRAGENT_E2E", e2e);
          vi.stubEnv("PWRAGENT_REPLAY_FIXTURE_PATH", hasFixture ? fixture : "");
          electron.app.isPackaged = isPackaged;
          createReplayClientsFromEnv();
          const snapshot = readTimingBridge();
          if (e2e !== "1" || !hasFixture || isPackaged) {
            expect(snapshot).toBeUndefined();
          } else {
            expect(snapshot).toBeTypeOf("function");
            // The existing rings are the oracle: export their sanitized snapshots unchanged.
            listingDiagnostics.record("workflow", "start", { query: "thread-start" });
            gitSubprocessDiagnostics.startGit("/contrived/private/path", ["status", "request-text"])(false);
            const timing = snapshot!();
            // Independent reads have different capture times; their retained data must agree.
            expect({ ...timing.listings, capturedAtMs: 0 }).toEqual({ ...listingDiagnostics.snapshot(), capturedAtMs: 0 });
            expect({ ...timing.git, capturedAtMs: 0 }).toEqual({ ...gitSubprocessDiagnostics.snapshot(), capturedAtMs: 0 });
            expect(JSON.stringify(timing)).not.toContain("/contrived/private/path");
            expect(JSON.stringify(timing)).not.toContain("request-text");
          }
        },
      ), { examples: [["1", true, false], ["1", true, true], ["1", false, false]] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
